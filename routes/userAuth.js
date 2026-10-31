// ============================================
// REE CLASS — Public user auth (Google Sign-In)
// ============================================
const supabase = require('../lib/supabase');
const { signUserToken, requireUser } = require('../lib/auth');
const { getGoogleClientId, verifyGoogleIdToken } = require('../lib/google');
const {
  getWalletSummary,
  isWalletSchemaMissing,
  walletUnavailable,
  WALLET_SETUP_ERROR
} = require('../lib/wallet');

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatar_url: user.avatar_url,
    status: user.status,
    wallet_balance: user.wallet_balance,
    created_at: user.created_at,
    last_login_at: user.last_login_at
  };
}

async function authPayload(user) {
  let summary = null;
  try {
    summary = await getWalletSummary(user.id);
  } catch (err) {
    if (!isWalletSchemaMissing(err)) {
      console.error('Wallet summary error:', err.message);
    }
  }
  return {
    token: signUserToken(user),
    user: publicUser(user),
    wallet: summary
  };
}

async function userAuthRoutes(fastify) {
  // GET /api/auth/google/config — Public
  fastify.get('/google/config', async () => {
    const clientId = getGoogleClientId();
    return { enabled: Boolean(clientId), clientId: clientId || null };
  });

  // POST /api/auth/google — Exchange a Google ID token for a user session
  fastify.post('/google', {
    config: { rateLimit: { max: 12, timeWindow: '1 minute' } }
  }, async (request, reply) => {
    try {
      const { credential } = request.body || {};
      if (!credential || typeof credential !== 'string' || credential.length > 8000) {
        return reply.status(400).send({ error: 'Missing Google credential' });
      }
      if (!getGoogleClientId()) {
        return reply.status(503).send({
          error: 'Google Sign-In is not configured yet. Add GOOGLE_CLIENT_ID to backend/.env and restart the server.'
        });
      }

      const googleUser = await verifyGoogleIdToken(credential);

      let { data: user, error } = await supabase
        .from('users')
        .select('*')
        .eq('google_sub', googleUser.sub)
        .single();

      if (error && isWalletSchemaMissing(error)) return walletUnavailable(reply);
      if (error && error.code !== 'PGRST116') {
        console.error('Google user lookup error:', error);
        return reply.status(500).send({ error: 'Failed to load account' });
      }

      if (!user) {
        // Recover an account created earlier with the same verified email.
        const { data: byEmail } = await supabase
          .from('users')
          .select('*')
          .eq('email', googleUser.email)
          .maybeSingle();

        if (byEmail) {
          const { data: updated, error: updateError } = await supabase
            .from('users')
            .update({
              google_sub: googleUser.sub,
              name: googleUser.name,
              avatar_url: googleUser.picture,
              last_login_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
            .eq('id', byEmail.id)
            .select('*')
            .single();
          if (updateError) {
            console.error('Google user relink error:', updateError);
            return reply.status(500).send({ error: 'Failed to update account' });
          }
          user = updated;
        } else {
          const { data: created, error: createError } = await supabase
            .from('users')
            .insert({
              google_sub: googleUser.sub,
              email: googleUser.email,
              name: googleUser.name,
              avatar_url: googleUser.picture,
              last_login_at: new Date().toISOString()
            })
            .select('*')
            .single();

          if (createError) {
            if (createError.code === '23505') {
              const { data: raced } = await supabase
                .from('users')
                .select('*')
                .eq('google_sub', googleUser.sub)
                .single();
              if (raced) {
                user = raced;
              }
            }
            if (!user) {
              console.error('Google user create error:', createError);
              return reply.status(500).send({ error: 'Failed to create account' });
            }
          } else {
            user = created;
          }
        }
      } else {
        const { data: updated, error: updateError } = await supabase
          .from('users')
          .update({
            name: googleUser.name,
            avatar_url: googleUser.picture,
            last_login_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
          .eq('id', user.id)
          .select('*')
          .single();

        if (updateError) {
          console.error('Google login update error:', updateError);
        } else {
          user = updated;
        }
      }

      if (user.status !== 'active') {
        return reply.status(403).send({ error: 'This account is suspended' });
      }

      return authPayload(user);
    } catch (err) {
      if (err.statusCode) {
        return reply.status(err.statusCode).send({ error: err.message });
      }
      if (isWalletSchemaMissing(err)) return walletUnavailable(reply);
      console.error('Google auth error:', err);
      return reply.status(500).send({ error: 'Google Sign-In failed. Please try again.' });
    }
  });

  // GET /api/auth/me — Current user + wallet summary
  fastify.get('/me', { preHandler: [requireUser] }, async (request, reply) => {
    try {
      const wallet = await getWalletSummary(request.user.id);
      return {
        user: publicUser(request.user),
        wallet
      };
    } catch (err) {
      if (isWalletSchemaMissing(err)) {
        return reply.status(503).send({ error: WALLET_SETUP_ERROR });
      }
      console.error('Auth me error:', err);
      return reply.status(500).send({ error: 'Failed to load account' });
    }
  });
}

module.exports = userAuthRoutes;
