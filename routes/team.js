// ============================================
// MX League — Team Members Routes (Optimized)
// ============================================
const supabase = require('../lib/supabase');
const cache = require('../lib/cache');
const { requireSuperAdmin } = require('../lib/auth');

const CACHE_KEY = 'team';
const CACHE_TTL = 120; // 2 min — team page is almost static

async function teamRoutes(fastify) {

  // GET /api/team — Public
  fastify.get('/', async (request, reply) => {
    const cached = cache.get(CACHE_KEY);
    if (cached) return cached;

    try {
      const { data, error } = await supabase
        .from('team_members')
        .select('id, name, role, bio, image_url')
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
    try {
      const { name, role, bio, image_url } = request.body;
      
      if (!name || !role) {
        return reply.status(400).send({ error: 'Name and role are required' });
      }

      const { data, error } = await supabase
        .from('team_members')
        .insert([{ name, role, bio, image_url }])
        .select()
        .single();

      if (error) throw error;
      cache.invalidate(CACHE_KEY);
      return data;
    } catch (err) {
      console.error('Error adding team member:', err);
      return reply.status(500).send({ error: 'Failed to add team member' });
    }
  });

  // PUT /api/team/:id — Super Admin only
  fastify.put('/:id', { preHandler: [requireSuperAdmin] }, async (request, reply) => {
    try {
      const { id } = request.params;
      const { name, role, bio, image_url } = request.body;
      
      const updates = {};
      if (name !== undefined) updates.name = name;
      if (role !== undefined) updates.role = role;
      if (bio !== undefined) updates.bio = bio;
      if (image_url !== undefined) updates.image_url = image_url;

      const { data, error } = await supabase
        .from('team_members')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      cache.invalidate(CACHE_KEY);
      return data;
    } catch (err) {
      console.error('Error updating team member:', err);
      return reply.status(500).send({ error: 'Failed to update team member' });
    }
  });

  // DELETE /api/team/:id — Super Admin only
  fastify.delete('/:id', { preHandler: [requireSuperAdmin] }, async (request, reply) => {
    try {
      const { id } = request.params;
      const { error } = await supabase
        .from('team_members')
        .delete()
        .eq('id', id);

      if (error) throw error;
      cache.invalidate(CACHE_KEY);
      return { success: true };
    } catch (err) {
      console.error('Error deleting team member:', err);
      return reply.status(500).send({ error: 'Failed to delete team member' });
    }
  });

}

module.exports = teamRoutes;
