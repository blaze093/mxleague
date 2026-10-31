// ============================================
// MX League — Auth Routes
// ============================================
const supabase = require('../lib/supabase');
const { signToken, comparePassword } = require('../lib/auth');

async function authRoutes(fastify) {
  // POST /api/auth/login
  fastify.post('/login', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } }
  }, async (request, reply) => {
    const { email, password } = request.body || {};

    if (!email || !password) {
      return reply.status(400).send({ error: 'Email and password required' });
    }

    // Look up admin in Supabase
    const { data: admin, error } = await supabase
      .from('admins')
      .select('*')
      .eq('email', email.toLowerCase().trim())
      .single();

    if (error || !admin) {
      return reply.status(401).send({ error: 'Invalid email or password' });
    }

    // Compare password with bcrypt hash
    const valid = await comparePassword(password, admin.password_hash);
    if (!valid) {
      return reply.status(401).send({ error: 'Invalid email or password' });
    }

    // Issue JWT
    const token = signToken({ 
      id: admin.id, 
      email: admin.email, 
      role: admin.role || 'staff',
      name: admin.name || 'Admin',
      permissions: admin.permissions || []
    });

    return { 
      token, 
      email: admin.email, 
      role: admin.role || 'staff', 
      name: admin.name || 'Admin',
      permissions: admin.permissions || []
    };
  });
}

module.exports = authRoutes;
