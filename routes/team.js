// ============================================
// REE CLASS — Team Members Routes
// ============================================
const supabase = require('../lib/supabase');
const cache = require('../lib/cache');
const { requireSuperAdmin } = require('../lib/auth');
const { logAudit } = require('../lib/audit');
const { isUuid } = require('../lib/identifiers');

const CACHE_KEY = 'team';
const CACHE_TTL = 120; // 2 min — team page is almost static
const FIELDS = 'id, name, role, bio, image_url, created_at';

function cleanText(value, maxLength) {
  return String(value == null ? '' : value)
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

// Team photos are rendered in an <img src>. Only allow normal web URLs so a
// stored value can never become a javascript:/data: URL.
function imageUrl(value) {
  const url = String(value == null ? '' : value).trim();
  if (!url) return null;
  if (url.length > 500) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function validate(body, { partial = false } = {}) {
  const values = {};
  const errors = [];

  if (!partial || body.name !== undefined) {
    const name = cleanText(body.name, 80);
    if (name.length < 2) errors.push('Name must be 2-80 characters');
    else values.name = name;
  }

  if (!partial || body.role !== undefined) {
    const role = cleanText(body.role, 60);
    if (role.length < 2) errors.push('Role must be 2-60 characters');
    else values.role = role;
  }

  if (!partial || body.bio !== undefined) {
    const bio = cleanText(body.bio, 500);
    values.bio = bio || null;
  }

  if (!partial || body.image_url !== undefined) {
    const url = imageUrl(body.image_url);
    if (url === undefined) errors.push('Image URL must be a valid https:// URL');
    else values.image_url = url;
  }

  return { values, errors };
}

async function teamRoutes(fastify) {
  // GET /api/team — Public
  fastify.get('/', async (request, reply) => {
    const cached = cache.get(CACHE_KEY);
    if (cached) return cached;

    try {
      const { data, error } = await supabase
        .from('team_members')
        .select(FIELDS)
        .order('created_at', { ascending: true });

      if (error) throw error;

      const result = data || [];
      cache.set(CACHE_KEY, result, CACHE_TTL);
      return result;
    } catch (err) {
      console.error('Error fetching team members:', err);
      return reply.status(500).send({ error: 'Failed to fetch team members' });
    }
  });

  // POST /api/team — Super Admin only
  fastify.post('/', { preHandler: [requireSuperAdmin] }, async (request, reply) => {
    const { values, errors } = validate(request.body || {});
    if (errors.length) return reply.status(400).send({ error: errors[0] });

    try {
      const { data, error } = await supabase
        .from('team_members')
        .insert([values])
        .select(FIELDS)
        .single();

      if (error) throw error;

      cache.invalidate(CACHE_KEY);
      await logAudit({
        admin: request.admin,
        action: 'team.create',
        targetType: 'team_member',
        targetId: data.id,
        details: { name: data.name, role: data.role },
        request
      });
      return data;
    } catch (err) {
      console.error('Error adding team member:', err);
      return reply.status(500).send({ error: 'Failed to add team member' });
    }
  });

  // PUT /api/team/:id — Super Admin only
  fastify.put('/:id', { preHandler: [requireSuperAdmin] }, async (request, reply) => {
    const { id } = request.params;
    if (!isUuid(id)) {
      return reply.status(400).send({ error: 'Invalid team member id' });
    }

    const { values, errors } = validate(request.body || {}, { partial: true });
    if (errors.length) return reply.status(400).send({ error: errors[0] });
    if (Object.keys(values).length === 0) {
      return reply.status(400).send({ error: 'No changes provided' });
    }

    try {
      const { data, error } = await supabase
        .from('team_members')
        .update(values)
        .eq('id', id)
        .select(FIELDS)
        .maybeSingle();

      if (error) throw error;
      if (!data) return reply.status(404).send({ error: 'Team member not found' });

      cache.invalidate(CACHE_KEY);
      await logAudit({
        admin: request.admin,
        action: 'team.update',
        targetType: 'team_member',
        targetId: data.id,
        details: { name: data.name, fields: Object.keys(values) },
        request
      });
      return data;
    } catch (err) {
      console.error('Error updating team member:', err);
      return reply.status(500).send({ error: 'Failed to update team member' });
    }
  });

  // DELETE /api/team/:id — Super Admin only
  fastify.delete('/:id', { preHandler: [requireSuperAdmin] }, async (request, reply) => {
    const { id } = request.params;
    if (!isUuid(id)) {
      return reply.status(400).send({ error: 'Invalid team member id' });
    }

    try {
      const { data, error } = await supabase
        .from('team_members')
        .delete()
        .eq('id', id)
        .select('id, name')
        .maybeSingle();

      if (error) throw error;
      if (!data) return reply.status(404).send({ error: 'Team member not found' });

      cache.invalidate(CACHE_KEY);
      await logAudit({
        admin: request.admin,
        action: 'team.delete',
        targetType: 'team_member',
        targetId: data.id,
        details: { name: data.name },
        request
      });
      return { success: true };
    } catch (err) {
      console.error('Error deleting team member:', err);
      return reply.status(500).send({ error: 'Failed to delete team member' });
    }
  });
}

module.exports = teamRoutes;
