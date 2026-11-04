// ============================================
// REE CLASS — First-party page-view analytics
// ============================================
const supabase = require('../lib/supabase');
const { verifyToken } = require('../lib/auth');
const { requestMeta, isMissingTableError } = require('../lib/audit');
const { recordTrafficMemory } = require('../lib/analytics');

const SESSION_RE = /^[A-Za-z0-9:_-]{8,100}$/;
const lastTouch = new Map();
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

function cleanPath(value) {
  const path = String(value || '/').split('?')[0].slice(0, 240);
  return path.startsWith('/') ? path : '/' + path;
}

function cleanReferrer(value) {
  const text = String(value || '').trim().slice(0, 500);
  if (!text) return null;
  try {
    const url = new URL(text);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString().slice(0, 500) : null;
  } catch {
    return null;
  }
}

function userFromRequest(request) {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  const decoded = verifyToken(header.slice(7).trim());
  if (!decoded || decoded.scope !== 'user' || !decoded.sub) return null;
  return decoded.sub;
}

async function touchUser(userId) {
  if (!userId) return;
  const now = Date.now();
  const last = lastTouch.get(userId) || 0;
  if (now - last < TOUCH_INTERVAL_MS) return;
  lastTouch.set(userId, now);
  if (lastTouch.size > 2000) {
    for (const [key, at] of lastTouch) {
      if (now - at > TOUCH_INTERVAL_MS) lastTouch.delete(key);
    }
  }
  try {
    await supabase
      .from('users')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', userId);
  } catch (err) {
    // Analytics must never break the public page.
    if (!isMissingTableError(err)) console.warn('last_seen update failed:', err.message);
  }
}

async function publicAnalyticsRoutes(fastify) {
  fastify.post('/pageview', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } }
  }, async (request, reply) => {
    const body = request.body || {};
    const sessionId = String(body.session_id || '').trim();
    if (!SESSION_RE.test(sessionId)) {
      return reply.status(400).send({ error: 'Invalid analytics session' });
    }

    const path = cleanPath(body.path);
    const referrer = cleanReferrer(body.referrer);
    const userId = userFromRequest(request);
    const meta = requestMeta(request);

    const event = {
      event_type: 'page_view',
      path,
      session_id: sessionId,
      user_id: userId,
      ip: meta.ip,
      user_agent: meta.userAgent,
      referrer
    };

    recordTrafficMemory(event);
    void touchUser(userId);

    try {
      let { error } = await supabase.from('site_events').insert(event);
      // A deleted user should not block anonymous traffic tracking.
      if (error && error.code === '23503' && userId) {
        const retry = await supabase.from('site_events').insert({ ...event, user_id: null });
        error = retry.error;
      }
      if (error) {
        if (isMissingTableError(error)) {
          return reply.status(202).send({ ok: true, tracked: false, setup_required: true });
        }
        console.error('Pageview insert error:', error.message);
        return reply.status(202).send({ ok: true, tracked: false });
      }
      return reply.status(202).send({ ok: true, tracked: true });
    } catch (err) {
      if (!isMissingTableError(err)) console.error('Pageview exception:', err.message);
      return reply.status(202).send({ ok: true, tracked: false });
    }
  });
}

module.exports = publicAnalyticsRoutes;
