// ============================================
// REE CLASS — Admin auth routes
// ============================================
const supabase = require('../lib/supabase');
const {
  signToken,
  comparePassword,
  passwordFingerprint,
  invalidateAdminContext,
  requireAdmin
} = require('../lib/auth');
const { logAudit } = require('../lib/audit');
const {
  checkLoginLockout,
  recordLoginFailure,
  recordLoginSuccess
} = require('../lib/security');

// A real bcrypt hash used when the email does not exist, so a missing account
// and a wrong password take the same amount of time.
const DUMMY_HASH = '$2a$10$BBwjDxgdpYLgS1ooP10lf.KgUN2hd5q724sv6T88mof4Acayh1IWy';

function cleanEmail(value) {
  return String(value || '').trim().toLowerCase().slice(0, 200);
}

async function authRoutes(fastify) {
  // POST /api/auth/login
  fastify.post('/login', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } }
  }, async (request, reply) => {
    const body = request.body || {};
    const email = cleanEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';

    if (!email || !password) {
      return reply.status(400).send({ error: 'Email and password required' });
    }
    if (email.length > 200 || password.length > 200) {
      return reply.status(400).send({ error: 'Invalid email or password' });
    }

    const ip = request.ip || null;

    try {
      const lockout = await checkLoginLockout(email, ip);
      if (lockout.locked) {
        reply.header('Retry-After', String(lockout.retryAfterSeconds));
        return reply.status(429).send({
          error: 'Too many failed attempts. Please wait a few minutes and try again.'
        });
      }

      const { data: admin, error } = await supabase
        .from('admins')
        .select('id, name, email, password_hash, role, permissions')
        .eq('email', email)
        .maybeSingle();

      if (error) {
        console.error('Admin login lookup error:', error.message);
        return reply.status(500).send({ error: 'Sign-in is temporarily unavailable' });
      }

      const valid = await comparePassword(password, admin?.password_hash || DUMMY_HASH);
      if (!admin || !valid) {
        await recordLoginFailure({ email, request });
        return reply.status(401).send({ error: 'Invalid email or password' });
      }

      const role = admin.role === 'super_admin' ? 'super_admin' : 'staff';
      const permissions = Array.isArray(admin.permissions) ? admin.permissions : [];
      // Force the next request to re-read the database instead of a stale
      // cached role/permission set from before this sign-in.
      invalidateAdminContext(admin.id);

      const token = signToken({
        id: admin.id,
        email: admin.email,
        role,
        name: admin.name || 'Admin',
        permissions,
        pwd: passwordFingerprint(admin.password_hash)
      });

      await Promise.allSettled([
        recordLoginSuccess({ email: admin.email, request }),
        logAudit({
          admin: { id: admin.id, name: admin.name || admin.email },
          action: 'admin.login',
          targetType: 'admin',
          targetId: admin.id,
          details: { role },
          request
        })
      ]);

      return {
        token,
        email: admin.email,
        role,
        name: admin.name || 'Admin',
        permissions
      };
    } catch (err) {
      console.error('Admin login exception:', err);
      return reply.status(500).send({ error: 'Sign-in is temporarily unavailable' });
    }
  });

  // GET /api/auth/admin/me — current admin identity straight from the database.
  // The panel uses this to refresh role/permission visibility after a staff
  // change without forcing the admin to sign in again.
  fastify.get('/admin/me', { preHandler: [requireAdmin] }, async (request) => {
    const admin = request.admin;
    return {
      id: admin.id,
      name: admin.name,
      email: admin.email,
      role: admin.role,
      permissions: admin.permissions
    };
  });
}

module.exports = authRoutes;
