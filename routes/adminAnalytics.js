// ============================================
// REE CLASS — Admin analytics API
// ============================================
const cache = require('../lib/cache');
const { requireAdminPermission } = require('../lib/auth');
const analytics = require('../lib/analytics');

function invalidDate(value) {
  if (!value) return false;
  return Number.isNaN(new Date(String(value)).getTime());
}

function rangeOrError(request, reply, options = {}) {
  if (invalidDate(request.query.from) || invalidDate(request.query.to)) {
    reply.status(400).send({ error: 'Invalid date range. Use ISO dates or YYYY-MM-DD.' });
    return null;
  }
  return analytics.parseRange(request.query, options);
}

async function adminAnalyticsRoutes(fastify) {
  fastify.addHook('onSend', async (request, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // GET /api/admin/analytics/overview?from=&to=
  fastify.get('/overview', { preHandler: [requireAdminPermission('analytics')] }, async (request, reply) => {
    const range = rangeOrError(request, reply);
    if (!range) return;

    const cacheKey = `analytics:overview:${range.from}:${range.to}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    try {
      const data = await analytics.getOverview(range);
      const result = { ...data, generated_at: new Date().toISOString() };
      cache.set(cacheKey, result, 15);
      return result;
    } catch (err) {
      console.error('Analytics overview error:', err);
      return reply.status(500).send({ error: 'Failed to load analytics' });
    }
  });

  // GET /api/admin/analytics/series?from=&to=&bucket=day|hour
  fastify.get('/series', { preHandler: [requireAdminPermission('analytics')] }, async (request, reply) => {
    const range = rangeOrError(request, reply);
    if (!range) return;

    const cacheKey = `analytics:series:${range.from}:${range.to}:${range.bucket}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    try {
      const data = await analytics.getSeries(range);
      const result = { ...data, generated_at: new Date().toISOString() };
      cache.set(cacheKey, result, 15);
      return result;
    } catch (err) {
      console.error('Analytics series error:', err);
      return reply.status(500).send({ error: 'Failed to load analytics series' });
    }
  });

  // GET /api/admin/analytics/traffic?from=&to=
  fastify.get('/traffic', { preHandler: [requireAdminPermission('analytics')] }, async (request, reply) => {
    const range = rangeOrError(request, reply);
    if (!range) return;

    try {
      const traffic = await analytics.getTraffic(range);
      return {
        range,
        ...traffic,
        generated_at: new Date().toISOString()
      };
    } catch (err) {
      console.error('Analytics traffic error:', err);
      return reply.status(500).send({ error: 'Failed to load traffic' });
    }
  });

  // GET /api/admin/analytics/tournaments?from=&to=
  fastify.get('/tournaments', { preHandler: [requireAdminPermission('analytics')] }, async (request, reply) => {
    const range = rangeOrError(request, reply);
    if (!range) return;

    try {
      return {
        range,
        ...(await analytics.getTournamentPerformance(range)),
        generated_at: new Date().toISOString()
      };
    } catch (err) {
      console.error('Analytics tournaments error:', err);
      return reply.status(500).send({ error: 'Failed to load tournament analytics' });
    }
  });

  // GET /api/admin/analytics/wallet-mix?from=&to=
  fastify.get('/wallet-mix', { preHandler: [requireAdminPermission('analytics')] }, async (request, reply) => {
    const range = rangeOrError(request, reply);
    if (!range) return;

    try {
      return {
        range,
        ...(await analytics.getWalletMix(range)),
        generated_at: new Date().toISOString()
      };
    } catch (err) {
      console.error('Analytics wallet mix error:', err);
      return reply.status(500).send({ error: 'Failed to load wallet analytics' });
    }
  });

  // GET /api/admin/analytics/realtime — light endpoint for the 30s live poll
  fastify.get('/realtime', { preHandler: [requireAdminPermission('analytics')] }, async (request, reply) => {
    try {
      const range = analytics.parseRange({ from: new Date(Date.now() - 60 * 60 * 1000).toISOString(), to: new Date().toISOString(), bucket: 'hour' });
      const traffic = await analytics.getTraffic(range);
      return {
        active_now: traffic.active_now,
        pageviews_last_hour: traffic.pageviews,
        visitors_last_hour: traffic.visitors,
        ready: traffic.ready,
        source: traffic.source,
        generated_at: new Date().toISOString()
      };
    } catch (err) {
      console.error('Analytics realtime error:', err);
      return reply.status(500).send({ error: 'Failed to load realtime traffic' });
    }
  });
}

module.exports = adminAnalyticsRoutes;
