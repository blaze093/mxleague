// ============================================
// REE CLASS — Tournament Routes
// ============================================
const supabase = require('../lib/supabase');
const cache = require('../lib/cache');
const { requireAdminPermission } = require('../lib/auth');
const { logAudit } = require('../lib/audit');

const CACHE_KEY = 'tournaments';
const CACHE_TTL = 30;
const BASE_FIELDS = 'id, name, mode, date, time, entry_fee, prize_pool, max_teams, status, updated_at';
const RICH_FIELDS = 'description, rules, banner_url, prize_first, prize_second, prize_third, registration_closes_at';
const ALL_FIELDS = `${BASE_FIELDS}, ${RICH_FIELDS}`;
const STATUSES = new Set(['upcoming', 'live', 'completed']);

function isMissingColumn(error) {
  if (!error) return false;
  if (error.code === '42703') return true;
  return /column .* does not exist/i.test(String(error.message || ''));
}

function cleanText(value, max = 2000) {
  return String(value == null ? '' : value)
    .replace(/<[^>]*>/g, '')
    .trim()
    .slice(0, max);
}

// Date-only strings come from <input type="date">. Reject impossible dates
// instead of letting PostgreSQL reject them with an opaque 500.
function dateValue(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined;
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) return undefined;
  return text;
}

// Accept 24-hour times from the current form plus legacy "8:00 PM" values
// already stored in the database.
function timeValue(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  if (!/^([01]?\d|2[0-3]):[0-5]\d(\s?[APap][Mm])?$/.test(text)) return undefined;
  return text;
}

function integer(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

function richValues(body) {
  const values = {};
  if (body.description !== undefined) values.description = cleanText(body.description, 2000) || null;
  if (body.rules !== undefined) values.rules = cleanText(body.rules, 6000) || null;
  if (body.banner_url !== undefined) {
    const url = String(body.banner_url || '').trim().slice(0, 500);
    // This value is later used inside a CSS url('...') in the tournament
    // modal, so reject quotes, parentheses, whitespace and backslashes as
    // well as non-https protocols.
    let valid = false;
    if (url && !/["'()\\\s]/.test(url)) {
      try {
        valid = new URL(url).protocol === 'https:';
      } catch {
        valid = false;
      }
    }
    values.banner_url = valid ? url : null;
  }
  for (const key of ['prize_first', 'prize_second', 'prize_third']) {
    if (body[key] !== undefined) {
      const n = integer(body[key], 0, 0, 10000000);
      if (n === null) return null;
      values[key] = n;
    }
  }
  if (body.registration_closes_at !== undefined) {
    const text = String(body.registration_closes_at || '').trim();
    if (!text) values.registration_closes_at = null;
    else {
      const date = new Date(text);
      if (Number.isNaN(date.getTime())) return null;
      values.registration_closes_at = date.toISOString();
    }
  }
  return values;
}

async function selectWithFallback(build) {
  const rich = await build(ALL_FIELDS);
  if (!rich.error || !isMissingColumn(rich.error)) return { ...rich, richReady: !rich.error };
  const base = await build(BASE_FIELDS);
  return { ...base, richReady: false };
}

async function tournamentRoutes(fastify) {
  // GET /api/tournaments — Public (optional ?status= filter)
  fastify.get('/', async (request, reply) => {
    const { status } = request.query;
    const cacheKey = status ? `${CACHE_KEY}:${status}` : CACHE_KEY;

    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const result = await selectWithFallback((fields) => {
      let query = supabase.from('tournaments').select(fields);
      if (status && STATUSES.has(String(status))) query = query.eq('status', String(status));
      return query.order('date', { ascending: false, nullsFirst: false });
    });

    if (result.error) {
      console.error('Tournaments list error:', result.error);
      return reply.status(500).send({ error: 'Failed to load tournaments' });
    }

    const payload = (result.data || []).map(row => ({ ...row, rich_ready: result.richReady }));
    cache.set(cacheKey, payload, CACHE_TTL);
    return payload;
  });

  // GET /api/tournaments/:id — Public
  fastify.get('/:id', async (request, reply) => {
    const id = request.params.id;
    const cacheKey = `${CACHE_KEY}:id:${id}`;

    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const result = await selectWithFallback((fields) =>
      supabase.from('tournaments').select(fields).eq('id', id).maybeSingle()
    );

    if (result.error || !result.data) {
      return reply.status(404).send({ error: 'Tournament not found' });
    }

    const payload = { ...result.data, rich_ready: result.richReady };
    cache.set(cacheKey, payload, CACHE_TTL);
    return payload;
  });

  // POST /api/tournaments — Admin only
  fastify.post('/', { preHandler: [requireAdminPermission('tournaments')] }, async (request, reply) => {
    const body = request.body || {};
    const name = cleanText(body.name, 120);
    if (!name) return reply.status(400).send({ error: 'Tournament name is required' });

    const mode = cleanText(body.mode, 40) || 'Squad';
    const status = body.status ? String(body.status) : 'upcoming';
    if (!STATUSES.has(status)) return reply.status(400).send({ error: 'Invalid tournament status' });

    const entryFee = integer(body.entry_fee, 0, 0, 1000000);
    const prizePool = integer(body.prize_pool, 0, 0, 10000000);
    const maxTeams = integer(body.max_teams, 13, 1, 1000);
    if ([entryFee, prizePool, maxTeams].includes(null)) {
      return reply.status(400).send({ error: 'Entry fee, prize pool and max teams must be valid numbers' });
    }

    const rich = richValues(body);
    if (rich === null) return reply.status(400).send({ error: 'Invalid prize or registration date' });

    const tournamentDate = dateValue(body.date);
    const tournamentTime = timeValue(body.time);
    if (tournamentDate === undefined) return reply.status(400).send({ error: 'Invalid tournament date' });
    if (tournamentTime === undefined) return reply.status(400).send({ error: 'Invalid tournament time' });

    const base = {
      name,
      mode,
      date: tournamentDate,
      time: tournamentTime,
      entry_fee: entryFee,
      prize_pool: prizePool,
      max_teams: maxTeams,
      status,
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('tournaments')
      .insert({ ...base, ...rich })
      .select()
      .single();

    if (error) {
      if (isMissingColumn(error) && Object.keys(rich).length) {
        return reply.status(503).send({
          error: 'Rich tournament fields need database/admin-upgrade.sql. Run it in Supabase, then save again.'
        });
      }
      console.error('Tournament create error:', error);
      return reply.status(500).send({ error: 'Failed to create tournament' });
    }

    cache.invalidate(CACHE_KEY);
    await logAudit({
      admin: request.admin,
      action: 'tournament.create',
      targetType: 'tournament',
      targetId: data.id,
      details: { name: data.name, entry_fee: data.entry_fee, status: data.status },
      request
    });
    return data;
  });

  // PUT /api/tournaments/:id — Admin only
  fastify.put('/:id', { preHandler: [requireAdminPermission('tournaments')] }, async (request, reply) => {
    const body = request.body || {};
    const updates = { updated_at: new Date().toISOString() };

    if (body.name !== undefined) {
      const name = cleanText(body.name, 120);
      if (!name) return reply.status(400).send({ error: 'Tournament name cannot be empty' });
      updates.name = name;
    }
    if (body.mode !== undefined) updates.mode = cleanText(body.mode, 40) || 'Squad';
    if (body.date !== undefined) {
      const date = dateValue(body.date);
      if (date === undefined) return reply.status(400).send({ error: 'Invalid tournament date' });
      updates.date = date;
    }
    if (body.time !== undefined) {
      const time = timeValue(body.time);
      if (time === undefined) return reply.status(400).send({ error: 'Invalid tournament time' });
      updates.time = time;
    }
    if (body.entry_fee !== undefined) {
      const n = integer(body.entry_fee, 0, 0, 1000000);
      if (n === null) return reply.status(400).send({ error: 'Invalid entry fee' });
      updates.entry_fee = n;
    }
    if (body.prize_pool !== undefined) {
      const n = integer(body.prize_pool, 0, 0, 10000000);
      if (n === null) return reply.status(400).send({ error: 'Invalid prize pool' });
      updates.prize_pool = n;
    }
    if (body.max_teams !== undefined) {
      const n = integer(body.max_teams, 13, 1, 1000);
      if (n === null) return reply.status(400).send({ error: 'Invalid team limit' });
      updates.max_teams = n;
    }
    if (body.status !== undefined) {
      if (!STATUSES.has(String(body.status))) return reply.status(400).send({ error: 'Invalid tournament status' });
      updates.status = String(body.status);
    }

    const rich = richValues(body);
    if (rich === null) return reply.status(400).send({ error: 'Invalid prize or registration date' });

    const { data, error } = await supabase
      .from('tournaments')
      .update({ ...updates, ...rich })
      .eq('id', request.params.id)
      .select()
      .maybeSingle();

    if (error) {
      if (isMissingColumn(error) && Object.keys(rich).length) {
        return reply.status(503).send({
          error: 'Rich tournament fields need database/admin-upgrade.sql. Run it in Supabase, then save again.'
        });
      }
      console.error('Tournament update error:', error);
      return reply.status(500).send({ error: 'Failed to update tournament' });
    }
    if (!data) return reply.status(404).send({ error: 'Tournament not found' });

    cache.invalidate(CACHE_KEY);
    await logAudit({
      admin: request.admin,
      action: 'tournament.update',
      targetType: 'tournament',
      targetId: data.id,
      details: { name: data.name, status: data.status, fields: Object.keys(updates).concat(Object.keys(rich)) },
      request
    });
    return data;
  });

  // DELETE /api/tournaments/:id — Admin only
  fastify.delete('/:id', { preHandler: [requireAdminPermission('tournaments')] }, async (request, reply) => {
    const { data, error } = await supabase
      .from('tournaments')
      .delete()
      .eq('id', request.params.id)
      .select('id, name')
      .maybeSingle();

    if (error) {
      console.error('Tournament delete error:', error);
      return reply.status(500).send({ error: 'Failed to delete tournament' });
    }
    if (!data) return reply.status(404).send({ error: 'Tournament not found' });

    cache.invalidate(CACHE_KEY);
    await logAudit({
      admin: request.admin,
      action: 'tournament.delete',
      targetType: 'tournament',
      targetId: data.id,
      details: { name: data.name },
      request
    });
    return { success: true };
  });
}

module.exports = tournamentRoutes;
