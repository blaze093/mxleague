// ============================================
// MX League — Staff Management Routes
// ============================================
const supabase = require('../lib/supabase');
const bcrypt = require('bcryptjs');
const { requireSuperAdmin, invalidateAdminContext } = require('../lib/auth');
const { logAudit } = require('../lib/audit');
const { isUuid } = require('../lib/identifiers');

const ALL_PERMISSIONS = [
  'dashboard', 'tournaments', 'bookings', 'topups', 'withdrawals',
  'wallets', 'results', 'live', 'gallery', 'staff', 'history', 'system', 'team',
  'users', 'analytics', 'security'
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_PASSWORD_BYTES = 72; // bcrypt only considers the first 72 bytes

function safePermissions(value) {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.filter(item => typeof item === 'string' && ALL_PERMISSIONS.includes(item)))];
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > maxLength) return null;
  return text;
}

function validPassword(value) {
  if (typeof value !== 'string') return null;
  if (value.length < 8) return null;
  if (Buffer.byteLength(value, 'utf8') > MAX_PASSWORD_BYTES) return null;
  return value;
}

function isUniqueViolation(error) {
  return error && (error.code === '23505' || /duplicate key/i.test(String(error.message || '')));
}

async function staffRoutes(fastify) {
  // GET /api/staff — List all staff
  fastify.get('/', { preHandler: [requireSuperAdmin] }, async (request, reply) => {
    const { data, error } = await supabase
      .from('admins')
      .select('id, name, email, role, permissions, created_at')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Staff GET error:', error.message);
      return reply.status(500).send({ error: 'Failed to load staff list' });
    }
    return data;
  });

  // POST /api/staff — Create new staff member
  fastify.post('/', { preHandler: [requireSuperAdmin] }, async (request, reply) => {
    const body = request.body || {};
    const name = cleanText(body.name, 80);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = validPassword(body.password);

    if (!name || name.length < 2) {
      return reply.status(400).send({ error: 'Name must be between 2 and 80 characters' });
    }
    if (!email || email.length > 200 || !EMAIL_RE.test(email)) {
      return reply.status(400).send({ error: 'Enter a valid email address' });
    }
    if (!password) {
      return reply.status(400).send({ error: 'Password must be 8–72 characters' });
    }

    const granted = safePermissions(body.permissions);
    const permissions = granted && granted.length > 0 ? granted : ['dashboard'];

    try {
      const password_hash = await bcrypt.hash(password, 10);

      const { data, error } = await supabase
        .from('admins')
        .insert({
          name,
          email,
          password_hash,
          role: 'staff',
          permissions
        })
        .select('id, name, email, role, permissions, created_at')
        .single();

      if (error) {
        if (isUniqueViolation(error)) {
          return reply.status(409).send({ error: 'An admin with this email already exists' });
        }
        console.error('Staff POST error:', error.message);
        return reply.status(500).send({ error: 'Failed to create staff member' });
      }

      await logAudit({
        admin: request.admin,
        action: 'staff.create',
        targetType: 'admin',
        targetId: data.id,
        details: { email: data.email, role: data.role, permissions: data.permissions },
        request
      });
      return data;
    } catch (err) {
      console.error('Staff POST exception:', err.message);
      return reply.status(500).send({ error: 'Failed to create staff member' });
    }
  });

  // PUT /api/staff/:id — Edit staff member
  fastify.put('/:id', { preHandler: [requireSuperAdmin] }, async (request, reply) => {
    const { id } = request.params;
    if (!isUuid(id)) {
      return reply.status(400).send({ error: 'Invalid staff member id' });
    }

    const body = request.body || {};

    const { data: existingAdmin, error: lookupError } = await supabase
      .from('admins')
      .select('id, name, email, role, permissions')
      .eq('id', id)
      .maybeSingle();

    if (lookupError) {
      console.error('Staff lookup error:', lookupError.message);
      return reply.status(500).send({ error: 'Failed to load staff member' });
    }
    if (!existingAdmin) {
      return reply.status(404).send({ error: 'Staff member not found' });
    }

    const updates = {};

    if (body.name !== undefined) {
      const name = cleanText(body.name, 80);
      if (!name || name.length < 2) {
        return reply.status(400).send({ error: 'Name must be between 2 and 80 characters' });
      }
      updates.name = name;
    }

    if (body.email !== undefined) {
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (!email || email.length > 200 || !EMAIL_RE.test(email)) {
        return reply.status(400).send({ error: 'Enter a valid email address' });
      }
      updates.email = email;
    }

    let nextRole = existingAdmin.role;
    if (body.role !== undefined) {
      if (!['staff', 'super_admin'].includes(body.role)) {
        return reply.status(400).send({ error: 'Role must be staff or super_admin' });
      }
      if (body.role === 'staff' && existingAdmin.role === 'super_admin' && id === request.admin.id) {
        return reply.status(400).send({ error: 'You cannot remove your own Super Admin role' });
      }
      nextRole = body.role;
      updates.role = body.role;
    }

    if (body.permissions !== undefined) {
      const granted = safePermissions(body.permissions);
      if (!granted) {
        return reply.status(400).send({ error: 'Permissions must be an array' });
      }
      updates.permissions = nextRole === 'super_admin' ? ALL_PERMISSIONS : granted;
    } else if (nextRole === 'super_admin' && existingAdmin.role !== 'super_admin') {
      updates.permissions = ALL_PERMISSIONS;
    }

    if (body.password !== undefined && body.password !== '') {
      const password = validPassword(body.password);
      if (!password) {
        return reply.status(400).send({ error: 'Password must be 8–72 characters' });
      }
      updates.password_hash = await bcrypt.hash(password, 10);
    }

    if (Object.keys(updates).length === 0) {
      return reply.status(400).send({ error: 'No changes provided' });
    }

    try {
      const { data, error } = await supabase
        .from('admins')
        .update(updates)
        .eq('id', id)
        .select('id, name, email, role, permissions, created_at')
        .single();

      if (error) {
        if (isUniqueViolation(error)) {
          return reply.status(409).send({ error: 'An admin with this email already exists' });
        }
        console.error('Staff PUT error:', error.message);
        return reply.status(500).send({ error: 'Failed to update staff member' });
      }

      // Role/permission/password changes must apply on the next request.
      invalidateAdminContext(id);

      await logAudit({
        admin: request.admin,
        action: 'staff.update',
        targetType: 'admin',
        targetId: data.id,
        details: {
          email: data.email,
          role: data.role,
          permissions: data.permissions,
          password_changed: Boolean(updates.password_hash)
        },
        request
      });

      return data;
    } catch (err) {
      console.error('Staff PUT exception:', err.message);
      return reply.status(500).send({ error: 'Failed to update staff member' });
    }
  });

  // DELETE /api/staff/:id — Delete staff member
  fastify.delete('/:id', { preHandler: [requireSuperAdmin] }, async (request, reply) => {
    const { id } = request.params;
    if (!isUuid(id)) {
      return reply.status(400).send({ error: 'Invalid staff member id' });
    }

    if (id === request.admin.id) {
      return reply.status(400).send({ error: 'You cannot delete your own account' });
    }

    try {
      const { data: targetAdmin, error: lookupError } = await supabase
        .from('admins')
        .select('role')
        .eq('id', id)
        .maybeSingle();

      if (lookupError) {
        console.error('Staff delete lookup error:', lookupError.message);
        return reply.status(500).send({ error: 'Failed to load staff member' });
      }
      if (!targetAdmin) {
        return reply.status(404).send({ error: 'Staff member not found' });
      }
      if (targetAdmin.role === 'super_admin') {
        return reply.status(403).send({ error: 'Cannot delete a Super Admin account' });
      }

      const { error } = await supabase
        .from('admins')
        .delete()
        .eq('id', id);

      if (error) {
        console.error('Staff DELETE error:', error.message);
        return reply.status(500).send({ error: 'Failed to delete staff member' });
      }

      invalidateAdminContext(id);

      await logAudit({
        admin: request.admin,
        action: 'staff.delete',
        targetType: 'admin',
        targetId: id,
        details: { role: targetAdmin.role },
        request
      });

      return { success: true, message: 'Staff member deleted' };
    } catch (err) {
      console.error('Staff DELETE exception:', err.message);
      return reply.status(500).send({ error: 'Failed to delete staff member' });
    }
  });
}

module.exports = staffRoutes;
