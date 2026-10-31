// ============================================
// MX League — Results Routes (Optimized)
// ============================================
const supabase = require('../lib/supabase');
const cache = require('../lib/cache');
const { requireAdmin } = require('../lib/auth');

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

const CACHE_TTL = 60; // 1 min

async function resultsRoutes(fastify) {
  // GET /api/results/:tournamentId — Public
  fastify.get('/:tournamentId', async (request, reply) => {
    const tid = request.params.tournamentId;
    const cacheKey = `results:${tid}`;

    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const { data, error } = await supabase
      .from('results')
      .select('id, tournament_id, team_name, kills, position, points')
      .eq('tournament_id', tid)
      .order('points', { ascending: false });

    if (error) {
      return reply.status(500).send({ error: 'Failed to load results' });
    }

    cache.set(cacheKey, data, CACHE_TTL);
    return data;
  });

  // POST /api/results/:tournamentId — Admin only (batch save/overwrite)
  fastify.post('/:tournamentId', { preHandler: [requireAdmin] }, async (request, reply) => {
    const tournamentId = request.params.tournamentId;
    const { results } = request.body || {};

    if (!results || !Array.isArray(results)) {
      return reply.status(400).send({ error: 'results array is required' });
    }

    // Delete existing results for this tournament
    const { error: delError } = await supabase
      .from('results')
      .delete()
      .eq('tournament_id', tournamentId);

    if (delError) {
      return reply.status(500).send({ error: 'Failed to clear old results' });
    }

    // Prepare new results with calculated points
    const rows = results.map(r => ({
      tournament_id: tournamentId,
      team_name: r.team_name,
      kills: parseInt(r.kills) || 0,
      position: parseInt(r.position) || 13,
      points: calcPoints(parseInt(r.kills) || 0, parseInt(r.position) || 13),
      updated_at: new Date().toISOString()
    }));

    const { data, error } = await supabase
      .from('results')
      .insert(rows)
      .select();

    if (error) {
      return reply.status(500).send({ error: 'Failed to save results' });
    }

    cache.invalidate(`results:${tournamentId}`);
    return data;
  });
}

module.exports = resultsRoutes;
