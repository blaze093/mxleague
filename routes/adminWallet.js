// ============================================
// REE CLASS — Admin wallet, booking & review routes
// ============================================
const crypto = require('crypto');
const supabase = require('../lib/supabase');
const cache = require('../lib/cache');
const { requireAdmin, requireAdminPermission } = require('../lib/auth');
const { logAudit } = require('../lib/audit');
const {
  parseAmount,
  cleanText,
  idempotencyKey,
  rpcErrorResponse,
  isWalletSchemaMissing,
  walletUnavailable,
  getWalletSummary
} = require('../lib/wallet');
const { getGoogleClientId } = require('../lib/google');

const REQUEST_STATUSES = new Set(['pending', 'approved', 'rejected']);
const BOOKING_STATUSES = new Set(['confirmed', 'cancelled']);

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    avatar_url: user.avatar_url,
    wallet_balance: Number(user.wallet_balance),
    status: user.status,
    created_at: user.created_at,
    last_login_at: user.last_login_at
  };
}

async function usersById(ids) {
  const unique = [...new Set((ids || []).filter(Boolean))];
  if (unique.length === 0) return new Map();
  const { data } = await supabase
    .from('users')
    .select('id, name, email, avatar_url')
    .in('id', unique);
  return new Map((data || []).map(user => [user.id, user]));
}

async function tournamentsById(ids) {
  const unique = [...new Set((ids || []).filter(Boolean))];
  if (unique.length === 0) return new Map();
  const { data } = await supabase
    .from('tournaments')
    .select('id, name, mode, date, time, entry_fee, status, max_teams')
    .in('id', unique);
  return new Map((data || []).map(t => [t.id, t]));
}

function statusFilter(value) {
  const status = String(value || '').trim();
  return REQUEST_STATUSES.has(status) || BOOKING_STATUSES.has(status) ? status : null;
}

async function adminWalletRoutes(fastify) {
  fastify.addHook('onSend', async (request, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // GET /api/admin/wallets/summary — aggregate dashboard figures
  fastify.get('/summary', { preHandler: [requireAdminPermission('dashboard')] }, async (request, reply) => {
    try {
      const { data, error } = await supabase.rpc('admin_wallet_summary');
      if (error) {
        if (isWalletSchemaMissing(error)) {
          return {
            ready: false,
            google_enabled: Boolean(getGoogleClientId()),
            users: 0,
            wallet_balance_total: 0,
            pending_topups: 0,
            pending_topups_amount: 0,
            pending_withdrawals: 0,
            pending_withdrawals_amount: 0,
            pending_total: 0,
            bookings: 0,
            booking_revenue: 0,
            lifetime_topups: 0,
            lifetime_withdrawals: 0,
            lifetime_refunds: 0,
            lifetime_admin_credits: 0
          };
        }
        console.error('Admin wallet summary error:', error);
        return reply.status(500).send({ error: 'Failed to load wallet summary' });
      }
      return {
        ready: true,
        google_enabled: Boolean(getGoogleClientId()),
        ...(data || {})
      };
    } catch (err) {
      console.error('Admin wallet summary exception:', err);
      return reply.status(500).send({ error: 'Failed to load wallet summary' });
    }
  });

  // GET /api/admin/wallets/pending-counts — nav badges
  fastify.get('/pending-counts', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const [topups, withdrawals] = await Promise.all([
        supabase.from('topup_requests').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
        supabase.from('withdrawal_requests').select('*', { count: 'exact', head: true }).eq('status', 'pending')
      ]);
      const topupCount = topups.error ? 0 : (topups.count || 0);
      const withdrawalCount = withdrawals.error ? 0 : (withdrawals.count || 0);
      return {
        topups: topupCount,
        withdrawals: withdrawalCount,
        total: topupCount + withdrawalCount
      };
    } catch (err) {
      return { topups: 0, withdrawals: 0, total: 0 };
    }
  });

  // ============================================
  // BOOKINGS
  // ============================================
  // GET /api/admin/wallets/bookings?tournament_id=&status=&include_legacy=1
  fastify.get('/bookings', { preHandler: [requireAdminPermission('bookings')] }, async (request, reply) => {
    try {
      const tournamentId = String(request.query.tournament_id || '').trim();
      const status = statusFilter(request.query.status);
      const includeLegacy = String(request.query.include_legacy || '1') !== '0';

      let query = supabase
        .from('bookings')
        .select('id, user_id, tournament_id, team_name, whatsapp, players, entry_fee, status, created_at, cancelled_at, refunded_at')
        .order('created_at', { ascending: false })
        .limit(300);
      if (tournamentId) query = query.eq('tournament_id', tournamentId);
      if (status) query = query.eq('status', status);

      const bookingsRes = await query;
      if (bookingsRes.error && isWalletSchemaMissing(bookingsRes.error)) {
        return walletUnavailable(reply);
      }
      if (bookingsRes.error) {
        console.error('Admin bookings error:', bookingsRes.error);
        return reply.status(500).send({ error: 'Failed to load bookings' });
      }

      let legacyRes = { data: [] };
      if (includeLegacy && (!status || status === 'confirmed')) {
        let legacyQuery = supabase
          .from('registrations')
          .select('id, tournament_id, team_name, whatsapp, players, created_at, approved_at, status')
          .eq('status', 'approved')
          .order('created_at', { ascending: false })
          .limit(300);
        if (tournamentId) legacyQuery = legacyQuery.eq('tournament_id', tournamentId);
        legacyRes = await legacyQuery;
        if (legacyRes.error) legacyRes = { data: [] };
      }

      const bookings = bookingsRes.data || [];
      const legacy = legacyRes.data || [];
      const [users, tournaments] = await Promise.all([
        usersById(bookings.map(row => row.user_id)),
        tournamentsById([
          ...bookings.map(row => row.tournament_id),
          ...legacy.map(row => row.tournament_id)
        ])
      ]);

      const mappedBookings = bookings.map(row => {
        const user = users.get(row.user_id);
        const tournament = tournaments.get(row.tournament_id);
        return {
          ...row,
          entry_fee: Number(row.entry_fee),
          legacy: false,
          user_name: user ? user.name : 'Unknown user',
          user_email: user ? user.email : '',
          user_avatar: user ? user.avatar_url : null,
          tournament_name: tournament ? tournament.name : 'Unknown tournament',
          tournament_date: tournament ? tournament.date : null,
          tournament_time: tournament ? tournament.time : null
        };
      });

      const mappedLegacy = legacy.map(row => {
        const tournament = tournaments.get(row.tournament_id);
        return {
          id: row.id,
          user_id: null,
          tournament_id: row.tournament_id,
          team_name: row.team_name,
          whatsapp: row.whatsapp,
          players: row.players,
          entry_fee: tournament ? Number(tournament.entry_fee) : 0,
          status: 'confirmed',
          created_at: row.approved_at || row.created_at,
          cancelled_at: null,
          refunded_at: null,
          legacy: true,
          user_name: 'Legacy entry',
          user_email: '',
          user_avatar: null,
          tournament_name: tournament ? tournament.name : 'Unknown tournament',
          tournament_date: tournament ? tournament.date : null,
          tournament_time: tournament ? tournament.time : null
        };
      });

      return [...mappedBookings, ...mappedLegacy]
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    } catch (err) {
      console.error('Admin bookings exception:', err);
      return reply.status(500).send({ error: 'Failed to load bookings' });
    }
  });

  // POST /api/admin/wallets/bookings/:id/cancel
  fastify.post('/bookings/:id/cancel', { preHandler: [requireAdminPermission('bookings')] }, async (request, reply) => {
    try {
      const reason = cleanText((request.body || {}).reason, 200);
      const { data, error } = await supabase.rpc('wallet_booking_cancel', {
        p_booking_id: request.params.id,
        p_admin_id: request.admin.id,
        p_reason: reason || 'Cancelled by admin'
      });
      if (error) return rpcErrorResponse(reply, error, 'Failed to cancel booking');

      const tournamentId = data && data.booking ? data.booking.tournament_id : null;
      if (tournamentId) cache.invalidate(`bookings:count:${tournamentId}`);
      cache.invalidate('dash');
      await logAudit({
        admin: request.admin,
        action: 'booking.cancel',
        targetType: 'booking',
        targetId: request.params.id,
        details: { reason: reason || 'Cancelled by admin', tournament_id: tournamentId },
        request
      });
      return data;
    } catch (err) {
      console.error('Cancel booking exception:', err);
      return reply.status(500).send({ error: 'Failed to cancel booking' });
    }
  });

  // ============================================
  // TOP-UPS
  // ============================================
  fastify.get('/topups', { preHandler: [requireAdminPermission('topups')] }, async (request, reply) => {
    try {
      const status = statusFilter(request.query.status);
      let query = supabase
        .from('topup_requests')
        .select('id, user_id, amount, screenshot_url, screenshot_public_id, upi_reference, status, admin_note, reviewed_by, reviewed_at, created_at')
        .order('created_at', { ascending: false })
        .limit(300);
      if (status) query = query.eq('status', status);

      const { data, error } = await query;
      if (error) {
        if (isWalletSchemaMissing(error)) return walletUnavailable(reply);
        console.error('Admin topups error:', error);
        return reply.status(500).send({ error: 'Failed to load top-up requests' });
      }

      const users = await usersById((data || []).map(row => row.user_id));
      return (data || []).map(row => {
        const user = users.get(row.user_id);
        return {
          ...row,
          amount: Number(row.amount),
          user_name: user ? user.name : 'Unknown user',
          user_email: user ? user.email : '',
          user_avatar: user ? user.avatar_url : null
        };
      });
    } catch (err) {
      console.error('Admin topups exception:', err);
      return reply.status(500).send({ error: 'Failed to load top-up requests' });
    }
  });

  fastify.post('/topups/:id/approve', { preHandler: [requireAdminPermission('topups')] }, async (request, reply) => {
    try {
      const note = cleanText((request.body || {}).admin_note, 300);
      const { data, error } = await supabase.rpc('wallet_topup_approve', {
        p_request_id: request.params.id,
        p_admin_id: request.admin.id,
        p_admin_note: note || null
      });
      if (error) return rpcErrorResponse(reply, error, 'Failed to approve top-up');
      cache.invalidate('dash');
      await logAudit({
        admin: request.admin,
        action: 'wallet.topup_approve',
        targetType: 'topup',
        targetId: request.params.id,
        details: { admin_note: note || null },
        request
      });
      return data;
    } catch (err) {
      console.error('Approve topup exception:', err);
      return reply.status(500).send({ error: 'Failed to approve top-up' });
    }
  });

  fastify.post('/topups/:id/reject', { preHandler: [requireAdminPermission('topups')] }, async (request, reply) => {
    try {
      const note = cleanText((request.body || {}).admin_note, 300);
      if (!note) return reply.status(400).send({ error: 'Add a reason so the user knows why it was rejected' });
      const { data, error } = await supabase.rpc('wallet_topup_reject', {
        p_request_id: request.params.id,
        p_admin_id: request.admin.id,
        p_admin_note: note
      });
      if (error) return rpcErrorResponse(reply, error, 'Failed to reject top-up');
      cache.invalidate('dash');
      await logAudit({
        admin: request.admin,
        action: 'wallet.topup_reject',
        targetType: 'topup',
        targetId: request.params.id,
        details: { admin_note: note },
        request
      });
      return data;
    } catch (err) {
      console.error('Reject topup exception:', err);
      return reply.status(500).send({ error: 'Failed to reject top-up' });
    }
  });

  // ============================================
  // WITHDRAWALS
  // ============================================
  fastify.get('/withdrawals', { preHandler: [requireAdminPermission('withdrawals')] }, async (request, reply) => {
    try {
      const status = statusFilter(request.query.status);
      let query = supabase
        .from('withdrawal_requests')
        .select('id, user_id, amount, upi_id, status, admin_note, upi_reference, reviewed_by, reviewed_at, created_at')
        .order('created_at', { ascending: false })
        .limit(300);
      if (status) query = query.eq('status', status);

      const { data, error } = await query;
      if (error) {
        if (isWalletSchemaMissing(error)) return walletUnavailable(reply);
        console.error('Admin withdrawals error:', error);
        return reply.status(500).send({ error: 'Failed to load withdrawal requests' });
      }

      const users = await usersById((data || []).map(row => row.user_id));
      return (data || []).map(row => {
        const user = users.get(row.user_id);
        return {
          ...row,
          amount: Number(row.amount),
          user_name: user ? user.name : 'Unknown user',
          user_email: user ? user.email : '',
          user_avatar: user ? user.avatar_url : null
        };
      });
    } catch (err) {
      console.error('Admin withdrawals exception:', err);
      return reply.status(500).send({ error: 'Failed to load withdrawal requests' });
    }
  });

  fastify.post('/withdrawals/:id/approve', { preHandler: [requireAdminPermission('withdrawals')] }, async (request, reply) => {
    try {
      const body = request.body || {};
      const note = cleanText(body.admin_note, 300);
      const reference = cleanText(body.upi_reference, 120);
      const { data, error } = await supabase.rpc('wallet_withdraw_approve', {
        p_request_id: request.params.id,
        p_admin_id: request.admin.id,
        p_admin_note: note || null,
        p_upi_reference: reference || null
      });
      if (error) return rpcErrorResponse(reply, error, 'Failed to approve withdrawal');
      cache.invalidate('dash');
      await logAudit({
        admin: request.admin,
        action: 'wallet.withdrawal_approve',
        targetType: 'withdrawal',
        targetId: request.params.id,
        details: { admin_note: note || null, upi_reference: reference || null },
        request
      });
      return data;
    } catch (err) {
      console.error('Approve withdrawal exception:', err);
      return reply.status(500).send({ error: 'Failed to approve withdrawal' });
    }
  });

  fastify.post('/withdrawals/:id/reject', { preHandler: [requireAdminPermission('withdrawals')] }, async (request, reply) => {
    try {
      const note = cleanText((request.body || {}).admin_note, 300);
      if (!note) return reply.status(400).send({ error: 'Add a reason so the user knows why it was rejected' });
      const { data, error } = await supabase.rpc('wallet_withdraw_reject', {
        p_request_id: request.params.id,
        p_admin_id: request.admin.id,
        p_admin_note: note
      });
      if (error) return rpcErrorResponse(reply, error, 'Failed to reject withdrawal');
      cache.invalidate('dash');
      await logAudit({
        admin: request.admin,
        action: 'wallet.withdrawal_reject',
        targetType: 'withdrawal',
        targetId: request.params.id,
        details: { admin_note: note },
        request
      });
      return data;
    } catch (err) {
      console.error('Reject withdrawal exception:', err);
      return reply.status(500).send({ error: 'Failed to reject withdrawal' });
    }
  });

  // ============================================
  // USERS / WALLETS
  // ============================================
  fastify.get('/users', { preHandler: [requireAdminPermission('wallets')] }, async (request, reply) => {
    try {
      const search = cleanText(request.query.search, 80);
      const limit = Math.min(200, Math.max(1, parseInt(request.query.limit, 10) || 100));

      let query = supabase
        .from('users')
        .select('id, name, email, avatar_url, wallet_balance, status, created_at, last_login_at')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (search) {
        const safe = search.replace(/[%,()]/g, ' ').trim();
        if (safe) query = query.or(`name.ilike.%${safe}%,email.ilike.%${safe}%`);
      }

      const { data, error } = await query;
      if (error) {
        if (isWalletSchemaMissing(error)) return walletUnavailable(reply);
        console.error('Admin users error:', error);
        return reply.status(500).send({ error: 'Failed to load users' });
      }
      return (data || []).map(publicUser);
    } catch (err) {
      console.error('Admin users exception:', err);
      return reply.status(500).send({ error: 'Failed to load users' });
    }
  });

  fastify.get('/users/:id', { preHandler: [requireAdminPermission('wallets')] }, async (request, reply) => {
    try {
      const { data: user, error } = await supabase
        .from('users')
        .select('*')
        .eq('id', request.params.id)
        .single();
      if (error || !user) return reply.status(404).send({ error: 'User not found' });

      const [wallet, transactions, bookings] = await Promise.all([
        getWalletSummary(user.id).catch(() => null),
        supabase.from('wallet_transactions')
          .select('id, type, direction, amount, balance_before, balance_after, description, reference_type, reference_id, created_at')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(50),
        supabase.from('bookings')
          .select('id, tournament_id, team_name, entry_fee, status, created_at')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(20)
      ]);

      return {
        user: publicUser(user),
        wallet,
        transactions: transactions.data || [],
        bookings: bookings.data || []
      };
    } catch (err) {
      console.error('Admin user detail exception:', err);
      return reply.status(500).send({ error: 'Failed to load user' });
    }
  });

  fastify.post('/users/:id/credit', { preHandler: [requireAdminPermission('wallets')] }, async (request, reply) => {
    try {
      const body = request.body || {};
      const amount = parseAmount(body.amount, { min: 1, max: 1000000 });
      if (!amount) {
        return reply.status(400).send({ error: 'Enter a valid credit amount between ₹1 and ₹10,00,000' });
      }
      const note = cleanText(body.note, 300);
      const key = idempotencyKey(body.idempotency_key) || `admin-${crypto.randomUUID()}`;

      const { data, error } = await supabase.rpc('wallet_admin_credit', {
        p_user_id: request.params.id,
        p_admin_id: request.admin.id,
        p_amount: amount,
        p_note: note || 'Manual wallet credit',
        p_idempotency_key: key
      });
      if (error) return rpcErrorResponse(reply, error, 'Failed to credit wallet');
      cache.invalidate('dash');
      await logAudit({
        admin: request.admin,
        action: 'wallet.credit',
        targetType: 'user',
        targetId: request.params.id,
        details: { amount, note: note || null, idempotency_key: key },
        request
      });
      return data;
    } catch (err) {
      console.error('Admin credit exception:', err);
      return reply.status(500).send({ error: 'Failed to credit wallet' });
    }
  });

  // POST /api/admin/wallets/users/:id/debit — atomic manual debit
  fastify.post('/users/:id/debit', { preHandler: [requireAdminPermission('wallets')] }, async (request, reply) => {
    try {
      const body = request.body || {};
      const amount = parseAmount(body.amount, { min: 1, max: 1000000 });
      if (!amount) {
        return reply.status(400).send({ error: 'Enter a valid debit amount between ₹1 and ₹10,00,000' });
      }
      const note = cleanText(body.note, 300);
      const key = idempotencyKey(body.idempotency_key) || `admin-${crypto.randomUUID()}`;

      const { data, error } = await supabase.rpc('wallet_admin_debit', {
        p_user_id: request.params.id,
        p_admin_id: request.admin.id,
        p_amount: amount,
        p_note: note || 'Manual wallet debit',
        p_idempotency_key: key
      });
      if (error) return rpcErrorResponse(reply, error, 'Failed to debit wallet');
      cache.invalidate('dash');
      await logAudit({
        admin: request.admin,
        action: 'wallet.debit',
        targetType: 'user',
        targetId: request.params.id,
        details: { amount, note: note || null, idempotency_key: key },
        request
      });
      return data;
    } catch (err) {
      console.error('Admin debit exception:', err);
      return reply.status(500).send({ error: 'Failed to debit wallet' });
    }
  });

  // GET /api/admin/wallets/transactions?user_id=&type=&limit=&offset=
  fastify.get('/transactions', { preHandler: [requireAdminPermission('wallets')] }, async (request, reply) => {
    try {
      const limit = Math.min(300, Math.max(1, parseInt(request.query.limit, 10) || 100));
      const offset = Math.max(0, parseInt(request.query.offset, 10) || 0);
      const userId = String(request.query.user_id || '').trim();
      const type = String(request.query.type || '').trim();
      const allowedTypes = ['topup', 'booking', 'withdrawal', 'admin_credit', 'refund'];

      let query = supabase
        .from('wallet_transactions')
        .select('id, user_id, type, direction, amount, balance_before, balance_after, description, reference_type, reference_id, created_at')
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
      if (userId) query = query.eq('user_id', userId);
      if (type && allowedTypes.includes(type)) query = query.eq('type', type);

      const { data, error } = await query;
      if (error) {
        if (isWalletSchemaMissing(error)) return walletUnavailable(reply);
        console.error('Admin transactions error:', error);
        return reply.status(500).send({ error: 'Failed to load transactions' });
      }

      const users = await usersById((data || []).map(row => row.user_id));
      return (data || []).map(row => {
        const user = users.get(row.user_id);
        return {
          ...row,
          amount: Number(row.amount),
          balance_before: Number(row.balance_before),
          balance_after: Number(row.balance_after),
          user_name: user ? user.name : 'Unknown user',
          user_email: user ? user.email : ''
        };
      });
    } catch (err) {
      console.error('Admin transactions exception:', err);
      return reply.status(500).send({ error: 'Failed to load transactions' });
    }
  });
}

module.exports = adminWalletRoutes;
