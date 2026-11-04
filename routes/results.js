// ============================================
// REE CLASS — Results Routes
// ============================================
const supabase = require('../lib/supabase');
const cache = require('../lib/cache');
const { requireAdminPermission } = require('../lib/auth');
const { logAudit } = require('../lib/audit');
const { isUuid } = require('../lib/identifiers');

const MAX_RESULTS = 100;

// Position points mapping (1st–13th)
const POSITION_POINTS = {
  1: 12, 2: 9, 3: 8, 4: 7, 5: 6,
  6: 5, 7: 4, 8: 3, 9: 2, 10: 1,
  11: 0, 12: 0, 13: 0
};

function calcPoints(kills, position) {
  const posPoints = POSITION_POINTS[position] || 0;
  return kills + posPoints;
}

function cleanText(value, maxLength) {
  return String(value == null ? '' : value)
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function parseInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

const CACHE_TTL = 60; // 1 min

async function resultsRoutes(fastify) {
  // GET /api/results/:tournamentId — Public
  fastify.get('/:tournamentId', async (request, reply) => {
    const tid = request.params.tournamentId;
    if (!isUuid(tid)) {
      return reply.status(400).send({ error: 'Invalid tournament id' });
    }

    const cacheKey = `results:${tid}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const { data, error } = await supabase
      .from('results')
      .select('id, tournament_id, team_name, kills, position, points')
      .eq('tournament_id', tid)
      .order('points', { ascending: false });

    if (error) {
      console.error('Results list error:', error);
      return reply.status(500).send({ error: 'Failed to load results' });
    }

    cache.set(cacheKey, data, CACHE_TTL);
    return data;
  });

  // POST /api/results/:tournamentId — Admin only (batch save/overwrite)
  fastify.post('/:tournamentId', {
    preHandler: [requireAdminPermission('results')]
  }, async (request, reply) => {
    const tournamentId = request.params.tournamentId;
    if (!isUuid(tournamentId)) {
      return reply.status(400).send({ error: 'Invalid tournament id' });
    }

    const body = request.body || {};
    if (!Array.isArray(body.results)) {
      return reply.status(400).send({ error: 'results array is required' });
    }
    if (body.results.length < 1 || body.results.length > MAX_RESULTS) {
      return reply.status(400).send({ error: `Enter 1-${MAX_RESULTS} result rows` });
    }

    const rows = [];
    const seenTeams = new Set();

    for (const [index, item] of body.results.entries()) {
      const row = item && typeof item === 'object' ? item : {};
      const teamName = cleanText(row.team_name, 80);
      const kills = parseInteger(row.kills);
      const position = parseInteger(row.position);

      if (teamName.length < 1) {
        return reply.status(400).send({ error: `Row ${index + 1}: team name is required` });
      }
      const teamKey = teamName.toLowerCase();
      if (seenTeams.has(teamKey)) {
        return reply.status(400).send({ error: `Duplicate team name: ${teamName}` });
      }
      seenTeams.add(teamKey);

      if (kills === null || kills < 0 || kills > 999) {
        return reply.status(400).send({ error: `Row ${index + 1}: kills must be a whole number between 0 and 999` });
      }
      if (position === null || position < 1 || position > 100) {
        return reply.status(400).send({ error: `Row ${index + 1}: position must be a whole number between 1 and 100` });
      }

      rows.push({
        tournament_id: tournamentId,
        team_name: teamName,
        kills,
        position,
        points: calcPoints(kills, position),
        updated_at: new Date().toISOString()
      });
    }

    // Verify the tournament first so a bad id fails before anything is deleted.
    const { data: tournament, error: tournamentError } = await supabase
      .from('tournaments')
      .select('id, name')
      .eq('id', tournamentId)
      .maybeSingle();

    if (tournamentError) {
      console.error('Results tournament lookup error:', tournamentError);
      return reply.status(500).send({ error: 'Failed to save results' });
    }
    if (!tournament) {
      return reply.status(404).send({ error: 'Tournament not found' });
    }

    // Keep the previous rows so they can be restored if the insert fails.
    // Supabase's REST API has no multi-statement transaction, so this is the
    // closest safe equivalent without adding a database function.
    const { data: previous, error: previousError } = await supabase
      .from('results')
      .select('id, tournament_id, team_name, kills, position, points, created_at, updated_at')
      .eq('tournament_id', tournamentId);

    if (previousError) {
      console.error('Results snapshot error:', previousError);
      return reply.status(500).send({ error: 'Failed to save results' });
    }

    const { error: delError } = await supabase
      .from('results')
      .delete()
      .eq('tournament_id', tournamentId);

    if (delError) {
      console.error('Results clear error:', delError);
      return reply.status(500).send({ error: 'Failed to clear old results' });
    }

    const { data, error } = await supabase
      .from('results')
      .insert(rows)
      .select();

    if (error) {
      console.error('Results insert error:', error);
      if (previous && previous.length) {
        const { error: restoreError } = await supabase.from('results').insert(previous);
        if (restoreError) console.error('Results restore error:', restoreError);
      }
      return reply.status(500).send({ error: 'Failed to save results' });
    }

    cache.invalidate(`results:${tournamentId}`);
    cache.invalidate('dash');

    await logAudit({
      admin: request.admin,
      action: 'results.update',
      targetType: 'tournament',
      targetId: tournamentId,
      details: {
        tournament: tournament.name,
        rows: rows.length,
        winner: [...rows].sort((a, b) => b.points - a.points)[0].team_name
      },
      request
    });

    return data;
  });
}

module.exports = resultsRoutes;
