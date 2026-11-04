// ============================================
// MX League — Settings Routes (Optimized)
// ============================================
const supabase = require('../lib/supabase');
const cache = require('../lib/cache');
const { requireSuperAdmin } = require('../lib/auth');
const { logAudit } = require('../lib/audit');

const CACHE_KEY = 'settings';
const CACHE_TTL = 60; // 1 min — settings rarely change

const TEXT_FIELDS = {
  upi_id: 120,
  about_text: 2000
};

const URL_FIELDS = {
  apk_download_link: 500,
  qr_image_url: 500,
  social_youtube: 500,
  social_whatsapp: 500,
  social_discord: 500,
  social_instagram: 500
};

function cleanText(value, maxLength) {
  const text = String(value ?? '').replace(/\r\n/g, '\n').trim();
  if (text.length > maxLength) return { error: `Must be at most ${maxLength} characters` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
    return { error: 'Contains invalid characters' };
  }
  return { value: text || null };
}

function cleanUrl(value, maxLength) {
  const text = String(value ?? '').trim();
  if (!text) return { value: null };
  if (text.length > maxLength) return { error: `Must be at most ${maxLength} characters` };
  // Reject characters that could break out of an HTML attribute or smuggle
  // a script URL. Attributes are also escaped on the client, but input
  // validation keeps bad data out of the database entirely.
  if (/["'<>\s\\]/.test(text)) return { error: 'Enter a valid URL' };
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return { error: 'Enter a valid URL' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { error: 'URL must start with http:// or https://' };
  }
  return { value: text };
}

async function settingsRoutes(fastify) {
  // GET /api/settings — Public
  fastify.get('/', async (request, reply) => {
    const cached = cache.get(CACHE_KEY);
    if (cached) return cached;

    try {
      const { data, error } = await supabase
        .from('settings')
        .select('id, upi_id, apk_download_link, qr_image_url, about_text, social_youtube, social_whatsapp, social_discord, social_instagram, updated_at')
        .eq('id', 1)
        .single();

      if (error) {
        console.error('Settings GET error:', error.message);
        return reply.status(500).send({ error: 'Failed to load settings' });
      }

      const result = data || {};
      cache.set(CACHE_KEY, result, CACHE_TTL);
      return result;
    } catch (err) {
      console.error('Settings GET exception:', err.message);
      return reply.status(500).send({ error: 'Failed to load settings' });
    }
  });

  // PUT /api/settings — Super Admin only
  fastify.put('/', { preHandler: [requireSuperAdmin] }, async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return reply.status(400).send({ error: 'Invalid settings payload' });
    }

    const updates = {};
    for (const [field, maxLength] of Object.entries(TEXT_FIELDS)) {
      if (body[field] === undefined) continue;
      if (typeof body[field] !== 'string') {
        return reply.status(400).send({ error: `${field} must be text` });
      }
      const result = cleanText(body[field], maxLength);
      if (result.error) return reply.status(400).send({ error: `${field}: ${result.error}` });
      updates[field] = result.value;
    }

    for (const [field, maxLength] of Object.entries(URL_FIELDS)) {
      if (body[field] === undefined) continue;
      if (typeof body[field] !== 'string') {
        return reply.status(400).send({ error: `${field} must be a URL` });
      }
      const result = cleanUrl(body[field], maxLength);
      if (result.error) return reply.status(400).send({ error: `${field}: ${result.error}` });
      updates[field] = result.value;
    }

    if (Object.keys(updates).length === 0) {
      return reply.status(400).send({ error: 'No settings provided' });
    }

    updates.updated_at = new Date().toISOString();

    try {
      const { data, error } = await supabase
        .from('settings')
        .update(updates)
        .eq('id', 1)
        .select()
        .single();

      if (error) {
        console.error('Settings PUT error:', error.message);
        return reply.status(500).send({ error: 'Failed to update settings' });
      }

      cache.invalidate(CACHE_KEY);

      await logAudit({
        admin: request.admin,
        action: 'settings.update',
        targetType: 'settings',
        targetId: '1',
        details: { fields: Object.keys(updates).filter(field => field !== 'updated_at') },
        request
      });

      return data;
    } catch (err) {
      console.error('Settings PUT exception:', err.message);
      return reply.status(500).send({ error: 'Failed to update settings' });
    }
  });
}

module.exports = settingsRoutes;
