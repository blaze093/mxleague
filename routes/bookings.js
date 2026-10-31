// ============================================
// REE CLASS — Wallet-paid slot bookings
// ============================================
const crypto = require('crypto');
const supabase = require('../lib/supabase');
const cache = require('../lib/cache');
const { requireUser } = require('../lib/auth');
const {
  cleanText,
  idempotencyKey,
  rpcErrorResponse,
  isWalletSchemaMissing
} = require('../lib/wallet');

const WHATSAPP_RE = /^\d{10,15}$/;

async function bookingRoutes(fastify) {
  // GET /api/bookings/count/:tournamentId — Public
  // Counts new bookings plus legacy approved registrations so a
  // pre-migration tournament can never be oversold.
  fastify.get('/count/:tournamentId', async (request, reply) => {
    const tournamentId = request.params.tournamentId;
    const cacheKey = `bookings:count:${tournamentId}`;
    const cached = cache.get(cacheKey);
    if (cached !== null) return cached;

    try {
      const [bookingsRes, legacyRes] = await Promise.all([
        supabase.from('bookings')
          .select('id', { count: 'exact' })
          .eq('tournament_id', tournamentId)
          .eq('status', 'confirmed')
          .limit(1),
        supabase.from('registrations')
          .select('id', { count: 'exact' })
          .eq('tournament_id', tournamentId)
          .eq('status', 'approved')
          .limit(1)
      ]);

      const walletReady = !bookingsRes.error;
      const legacy = legacyRes.error ? 0 : (legacyRes.count || 0);
      const booked = bookingsRes.error ? 0 : (bookingsRes.count || 0);
      const result = {
        count: booked + legacy,
        booked,
        legacy,
        wallet_ready: walletReady
      };
      cache.set(cacheKey, result, 15);
      return result;
    } catch (err) {
      console.error('Booking count error:', err);
      return reply.status(500).send({ error: 'Failed to count booked slots' });
    }
  });

  // GET /api/bookings/my — Current user's bookings
  fastify.get('/my', { preHandler: [requireUser] }, async (request, reply) => {
    try {
      const { data: bookings, error } = await supabase
        .from('bookings')
        .select('id, tournament_id, team_name, whatsapp, players, entry_fee, status, created_at, cancelled_at, refunded_at')
        .eq('user_id', request.user.id)
        .order('created_at', { ascending: false })
        .limit(100);

      if (error) {
        if (isWalletSchemaMissing(error)) {
          return reply.status(503).send({
            error: 'Bookings are not initialized yet. Run database/wallet-migration.sql in Supabase.'
          });
        }
        console.error('My bookings error:', error);
        return reply.status(500).send({ error: 'Failed to load bookings' });
      }

      const rows = bookings || [];
      const tournamentIds = [...new Set(rows.map(row => row.tournament_id).filter(Boolean))];
      let tournaments = [];
      if (tournamentIds.length > 0) {
        const { data } = await supabase
          .from('tournaments')
          .select('id, name, mode, date, time, entry_fee, prize_pool, status')
          .in('id', tournamentIds);
        tournaments = data || [];
      }
      const byId = new Map(tournaments.map(t => [t.id, t]));

      return rows.map(row => {
        const tournament = byId.get(row.tournament_id) || null;
        return {
          ...row,
          entry_fee: Number(row.entry_fee),
          tournament
        };
      });
    } catch (err) {
      console.error('My bookings exception:', err);
      return reply.status(500).send({ error: 'Failed to load bookings' });
    }
  });

  // POST /api/bookings — Deduct entry fee and confirm slot atomically
  fastify.post('/', {
    preHandler: [requireUser],
    config: { rateLimit: { max: 8, timeWindow: '1 minute' } }
  }, async (request, reply) => {
    try {
      const body = request.body || {};
      const tournamentId = String(body.tournament_id || '').trim();
      const teamName = cleanText(body.team_name, 50);
      const whatsapp = cleanText(body.whatsapp, 20);
      const players = Array.isArray(body.players)
        ? body.players.map(player => cleanText(player, 30)).filter(Boolean)
        : [];

      if (!tournamentId) {
        return reply.status(400).send({ error: 'Select a tournament' });
      }
      if (teamName.length < 2 || teamName.length > 50) {
        return reply.status(400).send({ error: 'Team name must be 2-50 characters' });
      }
      if (!WHATSAPP_RE.test(whatsapp)) {
        return reply.status(400).send({ error: 'Enter a valid WhatsApp number (10-15 digits)' });
      }
      if (players.length !== 4 || players.some(player => player.length < 1 || player.length > 30)) {
        return reply.status(400).send({ error: 'Enter all 4 player names (1-30 characters each)' });
      }

      const key = idempotencyKey(body.idempotency_key) ||
        `booking-${request.user.id.slice(0, 8)}-${crypto.randomUUID()}`;

      const { data, error } = await supabase.rpc('wallet_book_slot', {
        p_user_id: request.user.id,
        p_tournament_id: tournamentId,
        p_team_name: teamName,
        p_whatsapp: whatsapp,
        p_players: players,
        p_idempotency_key: key
      });

      if (error) return rpcErrorResponse(reply, error, 'Failed to book slot');

      cache.invalidate(`bookings:count:${tournamentId}`);
      cache.invalidate('dash');

      return reply.status(201).send({
        ...data,
        message: data && data.duplicate
          ? 'This booking was already confirmed.'
          : 'Slot confirmed and entry fee deducted from your wallet.'
      });
    } catch (err) {
      console.error('Booking create exception:', err);
      return reply.status(500).send({ error: 'Failed to book slot' });
    }
  });
}

module.exports = bookingRoutes;
