// ============================================
// REE CLASS — Auth Helpers (JWT + bcrypt)
// ============================================
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const supabase = require('./supabase');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('FATAL: JWT_SECRET environment variable is not set. Server cannot start.');
}
const ADMIN_TOKEN_TTL = '7d';
const USER_TOKEN_TTL = '30d';

function signToken(payload) {
  return jwt.sign({ ...payload, scope: 'admin' }, JWT_SECRET, { expiresIn: ADMIN_TOKEN_TTL });
}

function signUserToken(user) {
  return jwt.sign({
    sub: user.id,
    scope: 'user',
    email: user.email,
    name: user.name,
    picture: user.avatar_url || null,
    typ: 'user'
  }, JWT_SECRET, { expiresIn: USER_TOKEN_TTL });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

async function comparePassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function getBearerToken(request) {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice(7).trim() || null;
}

// Fastify preHandler hook — protects admin routes.
// User-scoped tokens are rejected even if they are valid JWTs.
async function requireAdmin(request, reply) {
  const token = getBearerToken(request);
  if (!token) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }
  const decoded = verifyToken(token);
  if (!decoded || decoded.scope === 'user' || !['staff', 'super_admin'].includes(decoded.role)) {
    return reply.status(401).send({ error: 'Invalid or expired admin session' });
  }
  request.admin = decoded;
}

// Fastify preHandler hook — strict protection for Super Admin routes.
async function requireSuperAdmin(request, reply) {
  await requireAdmin(request, reply);
  if (reply.sent) return;

  if (request.admin.role !== 'super_admin') {
    return reply.status(403).send({ error: 'Forbidden: Super Admin access required' });
  }
}

// Staff can access a panel only when the permission was granted.
function requireAdminPermission(permission) {
  return async function permissionGuard(request, reply) {
    await requireAdmin(request, reply);
    if (reply.sent) return;

    if (request.admin.role === 'super_admin') return;
    const permissions = Array.isArray(request.admin.permissions) ? request.admin.permissions : [];
    if (!permissions.includes(permission)) {
      return reply.status(403).send({ error: `Forbidden: ${permission} access required` });
    }
  };
}

// Fastify preHandler hook — protects public user routes.
// Loads the current user so suspensions and deleted accounts take effect
// immediately instead of waiting for the 30-day token to expire.
async function requireUser(request, reply) {
  const token = getBearerToken(request);
  if (!token) {
    return reply.status(401).send({ error: 'Please sign in to continue' });
  }
  const decoded = verifyToken(token);
  if (!decoded || decoded.scope !== 'user' || !decoded.sub) {
    return reply.status(401).send({ error: 'Invalid or expired session' });
  }

  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', decoded.sub)
    .single();

  if (error || !user) {
    if (error && (error.code === '42P01' || error.code === 'PGRST205' || error.code === 'PGRST202')) {
      return reply.status(503).send({
        error: 'Wallet accounts are not initialized yet. Run database/wallet-migration.sql in Supabase.'
      });
    }
    return reply.status(401).send({ error: 'Account not found. Please sign in again.' });
  }

  if (user.status !== 'active') {
    return reply.status(403).send({ error: 'This account is suspended' });
  }

  request.user = user;
}

module.exports = {
  signToken,
  signUserToken,
  verifyToken,
  comparePassword,
  requireAdmin,
  requireSuperAdmin,
  requireAdminPermission,
  requireUser
};
