// ============================================
// MX League — Staff Management Routes
// ============================================
const supabase = require('../lib/supabase');
const bcrypt = require('bcryptjs');
const { requireSuperAdmin } = require('../lib/auth');

const ALL_PERMISSIONS = [
  'dashboard', 'tournaments', 'bookings', 'topups', 'withdrawals',
  'wallets', 'results', 'live', 'gallery', 'staff', 'history', 'system', 'team'
];

function safePermissions(value) {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.filter(item => ALL_PERMISSIONS.includes(item)))];
}

async function staffRoutes(fastify) {
  // GET /api/staff — List all staff
  fastify.get('/', { preHandler: [requireSuperAdmin] }, async (request, reply) => {
    try {
      const { data, error } = await supabase
        .from('admins')
        .select('id, name, email, role, permissions, created_at')
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Staff GET error:', error);
        return reply.status(500).send({ error: 'Failed to load staff list' });
      }
      return data;
    } catch (err) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // POST /api/staff — Create new staff member
  fastify.post('/', { preHandler: [requireSuperAdmin] }, async (request, reply) => {
    try {
      const { name, email, password, permissions } = request.body;

      if (!name || !email || !password) {
        return reply.status(400).send({ error: 'Name, email, and password are required' });
      }

      if (password.length < 8) {
        return reply.status(400).send({ error: 'Password must be at least 8 characters' });
      }

      // Basic email format check
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return reply.status(400).send({ error: 'Invalid email format' });
      }

      // Check if email exists
      const { data: existing } = await supabase
        .from('admins')
        .select('id')
        .eq('email', email.toLowerCase().trim())
        .single();
      
      if (existing) {
        return reply.status(400).send({ error: 'Email already exists' });
      }

      // Hash password
      const password_hash = await bcrypt.hash(password, 10);

      // Default permissions if empty
      const perms = safePermissions(permissions) || ['dashboard'];

      const { data, error } = await supabase
        .from('admins')
        .insert({
          name: name.trim(),
          email: email.toLowerCase().trim(),
          password_hash,
          role: 'staff',
          permissions: perms
        })
        .select('id, name, email, role, permissions, created_at')
        .single();

      if (error) {
        console.error('Staff POST error:', error);
        return reply.status(500).send({ error: 'Failed to create staff member' });
      }
      return data;

    } catch (err) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // PUT /api/staff/:id — Edit staff member
  fastify.put('/:id', { preHandler: [requireSuperAdmin] }, async (request, reply) => {
    try {
      const { id } = request.params;
      const { name, email, password, permissions, role } = request.body;

      // Fetch existing
      const { data: existingAdmin } = await supabase
        .from('admins')
        .select('role')
        .eq('id', id)
        .single();

      if (!existingAdmin) {
        return reply.status(404).send({ error: 'Staff member not found' });
      }

      const updates = {};
      if (name) updates.name = name.trim();
      if (email) updates.email = email.toLowerCase().trim();
      
      const nextRole = role || existingAdmin.role;
      if (role) updates.role = role;

      if (Array.isArray(permissions)) {
          // If the final role will be super_admin, lock in all permissions.
          updates.permissions = nextRole === 'super_admin' ?
            ALL_PERMISSIONS :
            (safePermissions(permissions) || []);
      } else if (role && role === 'super_admin') {
          updates.permissions = ALL_PERMISSIONS;
      }
      
      if (password && password.length > 0) {
        updates.password_hash = await bcrypt.hash(password, 10);
      }

      const { data, error } = await supabase
        .from('admins')
        .update(updates)
        .eq('id', id)
        .select('id, name, email, role, permissions, created_at')
        .single();

      if (error) {
        console.error('Staff PUT error:', error);
        return reply.status(500).send({ error: 'Failed to update staff member' });
      }

      return data;
    } catch (err) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // DELETE /api/staff/:id — Delete staff member
  fastify.delete('/:id', { preHandler: [requireSuperAdmin] }, async (request, reply) => {
    try {
      const { id } = request.params;
      
      // Prevent deleting self
      if (id === request.admin.id) {
        return reply.status(400).send({ error: 'You cannot delete your own account' });
      }

      // Prevent deleting other super admins
      const { data: targetAdmin } = await supabase
        .from('admins')
        .select('role')
        .eq('id', id)
        .single();

      if (!targetAdmin) {
        return reply.status(404).send({ error: 'Staff member not found' });
      }

      if (targetAdmin.role === 'super_admin') {
        return reply.status(403).send({ error: 'Cannot delete a Super Admin account' });
      }

      const { data, error } = await supabase
        .from('admins')
        .delete()
        .eq('id', id)
        .select()
        .single();

      if (error) {
        console.error('Staff DELETE error:', error);
        return reply.status(500).send({ error: 'Failed to delete staff member' });
      }

      return { success: true, message: 'Staff member deleted' };
    } catch (err) {
      return reply.status(500).send({ error: err.message });
    }
  });
}

module.exports = staffRoutes;
