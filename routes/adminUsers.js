// ============================================
// REE CLASS — Admin user management
// ============================================
// Real user profiles, wallet controls, booking history and activity.
// Every sensitive action is written to admin_audit_log (with an in-memory
// fallback when the optional migration has not been applied yet).

const crypto = require('crypto');
const supabase = require('../lib/supabase');
const cache = require('../lib/cache');
const { requireAdminPermission } = require('../lib/auth');
const { logAudit, isMissingTableError } = require('../lib/audit');
const {
  parseAmount,
  cleanText,
  idempotencyKey,
  rpcErrorResponse,
  isWalletSchemaMissing,
  walletUnavailable,
  getWalletSummary
} = require('../lib/wallet');

const BASE_FIELDS = 'id, name, email, avatar_url, phone, wallet_balance, status, created_at, updated_at, last_login_at';
const MAX_PAGE = 100;
const STATUSES = new Set(['active', 'suspended']);

function isMissingColumn(error) {
  if (!error) return false;
  if (error.code === '42703') return true;
  return /column .* does not exist/i.test(String(error.message || ''));
}

function clampInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function safeSearch(value) {
  return String(value || '')
    .replace(/[%,()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    avatar_url: user.avatar_url || null,
    phone: user.phone || null,
    wallet_balance: Number(user.wallet_balance) || 0,
    status: user.status || 'active',
    created_at: user.created_at,
    updated_at: user.updated_at,
    last_login_at: user.last_login_at || null,
    last_seen_at: user.last_seen_at || null
  };
}

function orderFor(sort) {
  switch (sort) {
    case 'oldest':
      return { column: 'created_at', options: { ascending: true } };
    case 'name':
      return { column: 'name', options: { ascending: true } };
    case 'balance_high':
      return { column: 'wallet_balance', options: { ascending: false } };
    case 'balance_low':
      return { column: 'wallet_balance', options: { ascending: true } };
    case 'last_login':
      return { column: 'last_login_at', options: { ascending: false, nullsFirst: false } };
    default:
      return { column: 'created_at', options: { ascending: false } };
  }
}

async function usersById(ids) {
  const unique = [...new Set((ids || []).filter(Boolean))];
  if (!unique.length) return new Map();
  const { data, error } = await supabase
    .from('users')
    .select('id, name, email, avatar_url')
    .in('id', unique);
  if (error) return new Map();
  return new Map((data || []).map(user => [user.id, user]));
}

async function tournamentsById(ids) {
  const unique = [...new Set((ids || []).filter(Boolean))];
  if (!unique.length) return new Map();
  const { data, error } = await supabase
    .from('tournaments')
    .select('id, name, mode, date, time, entry_fee, prize_pool, status')
    .in('id', unique);
  if (error) return new Map();
  return new Map((data || []).map(t => [t.id, t]));
}

async function loadUser(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    if (isWalletSchemaMissing(error)) throw error;
    throw new Error('Failed to load user');
  }
  return data;
}

async function safeRows(query) {
  try {
    const { data, error } = await query;
    if (error) {
      if (isMissingTableError(error)) return { rows: [], missing: true };
      return { rows: [], missing: false, error: error.message };
    }
    return { rows: data || [], missing: false };
  } catch (err) {
    return { rows: [], missing: isMissingTableError(err), error: err.message };
  }
}

async function adminUsersRoutes(fastify) {
  fastify.addHook('onSend', async (request, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // GET /api/admin/users/summary — small aggregate for the users panel header
  fastify.get('/summary', { preHandler: [requireAdminPermission('users')] }, async (request, reply) => {
    try {
      const now = new Date();
      const day = 24 * 60 * 60 * 1000;
      const since7 = new Date(now.getTime() - 7 * day).toISOString();
      const since30 = new Date(now.getTime() - 30 * day).toISOString();

      const [total, active, suspended, new7, new30, walletRes] = await Promise.all([
        supabase.from('users').select('*', { count: 'exact', head: true }),
        supabase.from('users').select('*', { count: 'exact', head: true }).eq('status', 'active'),
        supabase.from('users').select('*', { count: 'exact', head: true }).eq('status', 'suspended'),
        supabase.from('users').select('*', { count: 'exact', head: true }).gte('created_at', since7),
        supabase.from('users').select('*', { count: 'exact', head: true }).gte('created_at', since30),
        supabase.rpc('admin_wallet_summary')
      ]);

      const totalCount = total.error ? 0 : total.count || 0;
      const activeCount = active.error ? 0 : active.count || 0;
      const suspendedCount = suspended.error ? 0 : suspended.count || 0;

      let walletFloat = 0;
      let walletReady = false;
      let walletPartial = false;
      if (!walletRes.error && walletRes.data) {
        walletFloat = Number(walletRes.data.wallet_balance_total) || 0;
        walletReady = true;
      } else {
        const walletRows = await supabase.from('users').select('wallet_balance').limit(5000);
        if (!walletRows.error) {
          walletFloat = (walletRows.data || []).reduce((sum, row) => sum + (Number(row.wallet_balance) || 0), 0);
          walletReady = true;
          walletPartial = (walletRows.data || []).length >= 5000;
        }
      }

      return {
        total: totalCount,
        active: activeCount,
        suspended: suspendedCount,
        new_last_7_days: new7.error ? 0 : new7.count || 0,
        new_last_30_days: new30.error ? 0 : new30.count || 0,
        wallet_float: walletFloat,
        wallet_ready: walletReady,
        wallet_partial: walletPartial
      };
    } catch (err) {
      console.error('Admin users summary error:', err);
      return reply.status(500).send({ error: 'Failed to load user summary' });
    }
  });

  // GET /api/admin/users?search=&status=&sort=&limit=&offset=
  fastify.get('/', { preHandler: [requireAdminPermission('users')] }, async (request, reply) => {
    try {
      const search = safeSearch(request.query.search);
      const status = STATUSES.has(String(request.query.status || '')) ? String(request.query.status) : null;
      const limit = clampInt(request.query.limit, 25, 1, MAX_PAGE);
      const offset = clampInt(request.query.offset, 0, 0, 100000);
      const { column, options } = orderFor(String(request.query.sort || 'newest'));

      const build = (fields) => {
        let query = supabase
          .from('users')
          .select(fields, { count: 'exact' })
          .order(column, options)
          .range(offset, offset + limit - 1);
        if (status) query = query.eq('status', status);
        if (search) query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`);
        return query;
      };

      let { data, error, count } = await build(`${BASE_FIELDS}, last_seen_at`);
      let lastSeenReady = true;
      if (error && isMissingColumn(error)) {
        lastSeenReady = false;
        const retry = await build(BASE_FIELDS);
        data = retry.data;
        error = retry.error;
        count = retry.count;
      }

      if (error) {
        if (isWalletSchemaMissing(error)) return walletUnavailable(reply);
        console.error('Admin users list error:', error);
        return reply.status(500).send({ error: 'Failed to load users' });
      }

      const users = (data || []).map(publicUser);
      const ids = users.map(user => user.id);

      // Bounded enrichment for the current page only.
      let bookingRows = [];
      if (ids.length) {
        const result = await safeRows(
          supabase
            .from('bookings')
            .select('user_id, entry_fee, status')
            .in('user_id', ids)
            .eq('status', 'confirmed')
        );
        bookingRows = result.rows;
      }

      const bookingStats = new Map();
      for (const row of bookingRows) {
        const entry = bookingStats.get(row.user_id) || { count: 0, spent: 0 };
        entry.count += 1;
        entry.spent += Number(row.entry_fee) || 0;
        bookingStats.set(row.user_id, entry);
      }

      for (const user of users) {
        const stats = bookingStats.get(user.id) || { count: 0, spent: 0 };
        user.booking_count = stats.count;
        user.total_spent = Math.round(stats.spent * 100) / 100;
      }

      return {
        users,
        total: count || 0,
        limit,
        offset,
        has_more: offset + users.length < (count || 0),
        last_seen_ready: lastSeenReady
      };
    } catch (err) {
      console.error('Admin users list exception:', err);
      return reply.status(500).send({ error: 'Failed to load users' });
    }
  });

  // GET /api/admin/users/:id — complete profile, wallet and activity
  fastify.get('/:id', { preHandler: [requireAdminPermission('users')] }, async (request, reply) => {
    try {
      let user;
      try {
        user = await loadUser(request.params.id);
      } catch (err) {
        if (isWalletSchemaMissing(err)) return walletUnavailable(reply);
        throw err;
      }
      if (!user) return reply.status(404).send({ error: 'User not found' });

      const [walletResult, txResult, bookingResult, securityResult, pageviewResult, auditResult] = await Promise.allSettled([
        getWalletSummary(user.id),
        safeRows(
          supabase
            .from('wallet_transactions')
            .select('id, type, direction, amount, balance_before, balance_after, description, reference_type, reference_id, created_at')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false })
            .limit(100)
        ),
        safeRows(
          supabase
            .from('bookings')
            .select('id, tournament_id, team_name, whatsapp, players, entry_fee, status, created_at, cancelled_at, refunded_at')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false })
            .limit(50)
        ),
        safeRows(
          supabase
            .from('security_events')
            .select('id, event_type, severity, ip, path, details, resolved, created_at')
            .eq('email', user.email)
            .order('created_at', { ascending: false })
            .limit(20)
        ),
        safeRows(
          supabase
            .from('site_events')
            .select('id, path, referrer, created_at')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false })
            .limit(20)
        ),
        safeRows(
          supabase
            .from('admin_audit_log')
            .select('id, admin_name, action, target_type, target_id, details, created_at')
            .eq('target_type', 'user')
            .eq('target_id', user.id)
            .order('created_at', { ascending: false })
            .limit(20)
        )
      ]);

      const pick = (result, fallback) => (result.status === 'fulfilled' ? result.value : fallback);
      const transactions = pick(txResult, { rows: [], missing: false }).rows;
      const bookings = pick(bookingResult, { rows: [], missing: false }).rows;
      const security = pick(securityResult, { rows: [], missing: false }).rows;
      const pageviews = pick(pageviewResult, { rows: [], missing: false }).rows;
      const audit = pick(auditResult, { rows: [], missing: false }).rows;

      const tournaments = await tournamentsById(bookings.map(row => row.tournament_id));
      const mappedBookings = bookings.map(row => {
        const tournament = tournaments.get(row.tournament_id);
        return {
          ...row,
          entry_fee: Number(row.entry_fee) || 0,
          tournament_name: tournament ? tournament.name : 'Removed tournament',
          tournament_date: tournament ? tournament.date : null,
          tournament_status: tournament ? tournament.status : null
        };
      });

      const confirmed = mappedBookings.filter(row => row.status === 'confirmed');
      const wallet = walletResult.status === 'fulfilled' ? walletResult.value : null;

      const timeline = [
        ...transactions.map(row => ({
          type: 'wallet',
          at: row.created_at,
          title: `${row.type === 'admin_credit' ? 'Manual' : row.type} ${row.direction}`,
          detail: row.description || '',
          amount: Number(row.amount) || 0,
          direction: row.direction
        })),
        ...mappedBookings.map(row => ({
          type: 'booking',
          at: row.created_at,
          title: `${row.team_name} — ${row.tournament_name}`,
          detail: row.status,
          amount: row.entry_fee,
          direction: 'debit'
        })),
        ...security.map(row => ({
          type: 'security',
          at: row.created_at,
          title: row.event_type,
          detail: row.path || row.ip || '',
          severity: row.severity
        })),
        ...pageviews.map(row => ({
          type: 'visit',
          at: row.created_at,
          title: row.path || '/',
          detail: row.referrer || 'Direct'
        }))
      ]
        .filter(item => item.at)
        .sort((a, b) => String(b.at).localeCompare(String(a.at)))
        .slice(0, 80);

      return {
        user: publicUser(user),
        wallet,
        stats: {
          confirmed_bookings: confirmed.length,
          cancelled_bookings: mappedBookings.length - confirmed.length,
          total_spent: Math.round(confirmed.reduce((sum, row) => sum + row.entry_fee, 0) * 100) / 100,
          transactions: transactions.length,
          security_events: security.length,
          pageviews: pageviews.length
        },
        transactions,
        bookings: mappedBookings,
        security,
        pageviews,
        audit,
        timeline,
        readiness: {
          wallet: Boolean(wallet),
          transactions: !pick(txResult, { missing: true }).missing,
          bookings: !pick(bookingResult, { missing: true }).missing,
          security: !pick(securityResult, { missing: true }).missing,
          traffic: !pick(pageviewResult, { missing: true }).missing,
          audit: !pick(auditResult, { missing: true }).missing
        }
      };
    } catch (err) {
      console.error('Admin user detail exception:', err);
      return reply.status(500).send({ error: 'Failed to load user' });
    }
  });

  // PATCH /api/admin/users/:id/status — suspend or reactivate an account
  fastify.patch('/:id/status', { preHandler: [requireAdminPermission('users')] }, async (request, reply) => {
    try {
      const status = String((request.body || {}).status || '').trim();
      const reason = cleanText((request.body || {}).reason, 300);
      if (!STATUSES.has(status)) {
        return reply.status(400).send({ error: 'Status must be active or suspended' });
      }
      if (status === 'suspended' && !reason) {
        return reply.status(400).send({ error: 'Add a reason for suspending this account' });
      }

      const { data: before, error: beforeError } = await supabase
        .from('users')
        .select('id, name, email, status')
        .eq('id', request.params.id)
        .maybeSingle();
      if (beforeError) {
        if (isWalletSchemaMissing(beforeError)) return walletUnavailable(reply);
        return reply.status(500).send({ error: 'Failed to load user' });
      }
      if (!before) return reply.status(404).send({ error: 'User not found' });

      const { data, error } = await supabase
        .from('users')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('id', request.params.id)
        .select('id, name, email, status, updated_at')
        .single();

      if (error) {
        console.error('Admin user status error:', error);
        return reply.status(500).send({ error: 'Failed to update account status' });
      }

      await logAudit({
        admin: request.admin,
        action: status === 'suspended' ? 'user.suspend' : 'user.reactivate',
        targetType: 'user',
        targetId: data.id,
        details: { previous_status: before.status, status, reason: reason || null, email: data.email },
        request
      });

      return { user: data, previous_status: before.status };
    } catch (err) {
      console.error('Admin user status exception:', err);
      return reply.status(500).send({ error: 'Failed to update account status' });
    }
  });

  // POST /api/admin/users/:id/credit — atomic manual credit
  fastify.post('/:id/credit', { preHandler: [requireAdminPermission('users')] }, async (request, reply) => {
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
      if (!data || !data.duplicate) {
        await logAudit({
          admin: request.admin,
          action: 'wallet.credit',
          targetType: 'user',
          targetId: request.params.id,
          details: { amount, note: note || null, idempotency_key: key },
          request
        });
      }
      return data;
    } catch (err) {
      console.error('Admin user credit exception:', err);
      return reply.status(500).send({ error: 'Failed to credit wallet' });
    }
  });

  // POST /api/admin/users/:id/debit — atomic manual debit
  fastify.post('/:id/debit', { preHandler: [requireAdminPermission('users')] }, async (request, reply) => {
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

      if (error) {
        if (!isWalletSchemaMissing(error)) return rpcErrorResponse(reply, error, 'Failed to debit wallet');
        // wallet_admin_debit is part of admin-upgrade.sql. Fall back to a
        // compare-and-swap debit only while that migration is not applied.
        const fallback = await fallbackDebit({
          userId: request.params.id,
          adminId: request.admin.id,
          amount,
          note,
          key
        });
        if (fallback.error) {
          return reply.status(fallback.status || 500).send({ error: fallback.error });
        }
        cache.invalidate('dash');
        if (!fallback.data || !fallback.data.duplicate) {
          await logAudit({
            admin: request.admin,
            action: 'wallet.debit',
            targetType: 'user',
            targetId: request.params.id,
            details: { amount, note: note || null, fallback: true, idempotency_key: key },
            request
          });
        }
        return fallback.data;
      }

      cache.invalidate('dash');
      if (!data || !data.duplicate) {
        await logAudit({
          admin: request.admin,
          action: 'wallet.debit',
          targetType: 'user',
          targetId: request.params.id,
          details: { amount, note: note || null, idempotency_key: key },
          request
        });
      }
      return data;
    } catch (err) {
      console.error('Admin user debit exception:', err);
      return reply.status(500).send({ error: 'Failed to debit wallet' });
    }
  });
}

// Compare-and-swap fallback used only when wallet_admin_debit is missing.
// It is still race-safe: the UPDATE only succeeds when the balance is unchanged.
async function fallbackDebit({ userId, adminId, amount, note, key }) {
  const ledgerKey = `admin_debit:${key}`;

  try {
    const { data: existing } = await supabase
      .from('wallet_transactions')
      .select('id, balance_after')
      .eq('idempotency_key', ledgerKey)
      .maybeSingle();
    if (existing) {
      return { data: { balance: Number(existing.balance_after), duplicate: true } };
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { data: user, error } = await supabase
        .from('users')
        .select('id, wallet_balance')
        .eq('id', userId)
        .maybeSingle();
      if (error) throw error;
      if (!user) return { status: 404, error: 'User not found' };

      const before = Number(user.wallet_balance) || 0;
      if (before < amount) return { status: 409, error: 'Insufficient wallet balance' };
      const after = Math.round((before - amount) * 100) / 100;

      const { data: updated, error: updateError } = await supabase
        .from('users')
        .update({ wallet_balance: after, updated_at: new Date().toISOString() })
        .eq('id', userId)
        .eq('wallet_balance', before)
        .select('id')
        .maybeSingle();

      if (updateError) throw updateError;
      if (!updated) continue; // balance changed underneath us — retry

      const { error: insertError } = await supabase
        .from('wallet_transactions')
        .insert({
          user_id: userId,
          type: 'admin_credit',
          direction: 'debit',
          amount,
          balance_before: before,
          balance_after: after,
          reference_type: 'admin_debit',
          reference_id: null,
          description: note || 'Manual wallet debit by admin',
          idempotency_key: ledgerKey,
          created_by: adminId
        });

      if (insertError) {
        // Compensate so the ledger and balance never diverge.
        await supabase
          .from('users')
          .update({ wallet_balance: before, updated_at: new Date().toISOString() })
          .eq('id', userId)
          .eq('wallet_balance', after);
        throw insertError;
      }

      return { data: { balance: after, duplicate: false } };
    }

    return { status: 409, error: 'Wallet changed while processing. Please try again.' };
  } catch (err) {
    console.error('Fallback debit error:', err);
    return { status: 500, error: 'Failed to debit wallet' };
  }
}

module.exports = adminUsersRoutes;
