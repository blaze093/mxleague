//============================================
// MX League — Fastify Server Entry Point (Optimized)
// ============================================
require('dotenv').config();

const path = require('path');
const os = require('os'); // Hoisted — never require inside hot paths
const { recordRequest, recordError } = require('./lib/metrics');
const {
  recordRateLimit,
  recordSuspiciousRequest,
  isSuspiciousPath
} = require('./lib/security');

// trustProxy is configurable because blindly trusting every X-Forwarded-For
// value lets clients spoof their IP and defeat rate limits / audit logs.
// Default: one proxy hop in production (Render/nginx), no proxy trust in dev.
// Override with TRUST_PROXY=false|true|<number-of-hops>.
function parseTrustProxy(value) {
  if (value === undefined || value === '') {
    return process.env.NODE_ENV === 'production' ? 1 : false;
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  const hops = Number(value);
  return Number.isInteger(hops) && hops >= 0 && hops <= 10 ? hops : false;
}

const fastify = require('fastify')({
  logger: process.env.NODE_ENV === 'production' ? { level: 'error' } : true,
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  keepAliveTimeout: 120000,
  headersTimeout: 121000,
  bodyLimit: 1048576, // 1MB — rejects oversized payloads before parsing
  routerOptions: {
    caseSensitive: true, // Faster route matching
    ignoreDuplicateSlashes: true,
    ignoreTrailingSlash: true
  }
});

async function start() {
  // CORS — strict allowlist (comma-separated origins via env var, defaults for production)
  const allowedOrigins = (process.env.CORS_ORIGINS || 'https://tictacarena.in,https://www.tictacarena.in')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

 

  await fastify.register(require('@fastify/cors'), {
    origin: (origin, cb) => {
      // Requests without an Origin header (curl, server-to-server, same-origin) are allowed
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      // Unknown origins get no CORS headers (the browser blocks the response)
      // instead of a noisy 500 from a thrown error.
      return cb(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
  });

 // Security Headers (Helmet)
await fastify.register(require('@fastify/helmet'), {
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: {
    policy: 'same-origin-allow-popups'
  }
});

  // Compression (Gzip / Brotli)
  await fastify.register(require('@fastify/compress'), {
    global: true,
    threshold: 512, // Only compress responses > 512 bytes (avoids wasting CPU on tiny payloads)
    encodings: ['gzip', 'deflate'] // Skip brotli — too CPU-heavy for free tier
  });

  // Load Shedding
  await fastify.register(require('@fastify/under-pressure'), {
    maxEventLoopDelay: 1000,
    maxHeapUsedBytes: 300000000,
    maxRssBytes: 350000000,
    maxEventLoopUtilization: 0.98,
    message: 'Server is overloaded, please try again later',
    retryAfter: 50
  });

  // Serve frontend static files. HTML is always revalidated so a deploy is
  // visible immediately; hashed/static assets get a bounded cache instead of
  // the previous 30-day immutable cache on every file.
  const isProd = process.env.NODE_ENV === 'production';
  await fastify.register(require('@fastify/static'), {
    root: path.join(__dirname, '..'),
    prefix: '/',
    maxAge: 0,
    immutable: false,
    cacheControl: false,
    lastModified: true,
    dotfiles: 'deny',
    // @fastify/static v10 passes the Fastify reply (v9 passed the raw
    // response). Support both shapes so a future downgrade stays safe.
    setHeaders: (replyOrRes, filePath) => {
      const set = (name, value) => {
        if (typeof replyOrRes.header === 'function') replyOrRes.header(name, value);
        else if (typeof replyOrRes.setHeader === 'function') replyOrRes.setHeader(name, value);
      };
      const ext = path.extname(filePath).toLowerCase();
      // HTML, JS and CSS are not fingerprinted, so always revalidate them.
      // A stale bundle after a deploy is worse than a conditional request.
      if (ext === '.html' || ext === '.js' || ext === '.css') {
        set('Cache-Control', 'no-cache, must-revalidate');
        return;
      }
      if (!isProd) {
        set('Cache-Control', 'no-cache');
        return;
      }
      if (ext === '.jpg' || ext === '.jpeg' || ext === '.png' || ext === '.webp' || ext === '.svg' || ext === '.woff2') {
        set('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
      } else {
        set('Cache-Control', 'public, max-age=3600, must-revalidate');
      }
    },
    // Never expose backend source, environment files, SQL, or docs.
    allowedPath: (pathname) => {
      const p = pathname.replace(/\\/g, '/');
      return p === '/' ||
        p === '/index.html' ||
        p === '/admin.html' ||
        p === '/favicon.svg' ||
        p === '/logo.png' ||
        p.startsWith('/css/') ||
        p.startsWith('/js/') ||
        p.startsWith('/assets/');
    }
  });

  // Request timing + suspicious scanner detection.
  fastify.addHook('onRequest', async (request) => {
    request.startTime = process.hrtime.bigint();
    if (isSuspiciousPath(request.url)) {
      void recordSuspiciousRequest(request);
    }
  });

  fastify.addHook('onResponse', async (request, reply) => {
    const start = request.startTime;
    const durationMs = start ? Number(process.hrtime.bigint() - start) / 1e6 : 0;
    recordRequest(request, reply, durationMs);
  });

  // Global error handler — never leak internal error details to clients
  fastify.setErrorHandler((error, request, reply) => {
    recordError(error, request);
    if (error.statusCode === 429) {
      void recordRateLimit(request);
    }
    if (process.env.NODE_ENV !== 'production') {
      console.error('❌ Unhandled error:', error.message);
      console.error('   Route:', request.method, request.url);
    }
    const statusCode = error.statusCode || 500;
    const message = statusCode >= 500 ? 'Internal Server Error' : (error.message || 'Internal Server Error');
    reply.status(statusCode).send({
      error: message
    });
  });

  // Rate limiting
  // A baseline limit covers every API route (including ones without their
  // own config). Expensive/sensitive routes keep stricter per-route limits.
  // Static assets and HTML documents are excluded so normal page loads are
  // never counted.
  await fastify.register(require('@fastify/rate-limit'), {
    global: true,
    max: 240,
    timeWindow: '1 minute',
    allowList: (request) => !request.url.startsWith('/api/'),
    onExceeded: (request) => {
      void recordRateLimit(request);
    }
  });

  // Register API routes
  fastify.register(require('./routes/auth'), { prefix: '/api/auth' });
  fastify.register(require('./routes/userAuth'), { prefix: '/api/auth' });
  fastify.register(require('./routes/settings'), { prefix: '/api/settings' });
  fastify.register(require('./routes/tournaments'), { prefix: '/api/tournaments' });
  fastify.register(require('./routes/bookings'), { prefix: '/api/bookings' });
  fastify.register(require('./routes/wallet'), { prefix: '/api/wallet' });
  fastify.register(require('./routes/adminWallet'), { prefix: '/api/admin/wallets' });
  fastify.register(require('./routes/adminUsers'), { prefix: '/api/admin/users' });
  fastify.register(require('./routes/adminAnalytics'), { prefix: '/api/admin/analytics' });
  fastify.register(require('./routes/adminSecurity'), { prefix: '/api/admin/security' });
  fastify.register(require('./routes/publicAnalytics'), { prefix: '/api/analytics' });
  fastify.register(require('./routes/results'), { prefix: '/api/results' });
  fastify.register(require('./routes/dashboard'), { prefix: '/api/dashboard' });
  fastify.register(require('./routes/staff'), { prefix: '/api/staff' });
  fastify.register(require('./routes/team'), { prefix: '/api/team' });

  // Ultra-Fast Health check — pre-computed, zero allocations
  fastify.get('/api/health', (request, reply) => {
    return { status: 'ok', uptime: process.uptime() };
  });

  // KEEP-AWAKE: Prevent Supabase DB from pausing (every 6 days)
  const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;
  setInterval(async () => {
    try {
      const supabase = require('./lib/supabase');
      await supabase.from('settings').select('id').limit(1);
    } catch (e) {
      console.error('❌ Failed to ping Supabase for keep-awake:', e.message);
    }
  }, SIX_DAYS_MS);

  // Start server
  const port = process.env.PORT || 3000;
  try {
    await fastify.listen({ port, host: '0.0.0.0' });
    const procType = process.env.NODE_ENV === 'production' ? `Worker ${process.pid}` : 'API';
    console.log(`\n🎮 MX League ${procType} running on http://0.0.0.0:${port}\n`);
    console.log(`   CORS origins: ${allowedOrigins.join(', ')}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }

  // Graceful shutdown — stop accepting connections, let in-flight requests
  // finish, then exit. Render sends SIGTERM on every deploy.
  const shutdown = async (signal) => {
    console.log(`\n🛑 ${signal} received — closing server gracefully...`);
    try {
      await fastify.close();
    } catch (err) {
      console.error('Shutdown error:', err.message);
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

// ============================================
// CLUSTER MODE: Multi-Core Extreme Performance
// ============================================
const cluster = require('cluster');

// A single worker keeps in-process API metrics, rate limits and the analytics
// fallback consistent. Set CLUSTER_WORKERS=2 to opt into multi-core mode.
const configuredWorkers = parseInt(process.env.CLUSTER_WORKERS, 10);
const workerCount = Number.isFinite(configuredWorkers)
  ? Math.min(4, Math.max(1, configuredWorkers))
  : 1;

if (process.env.NODE_ENV === 'production' && cluster.isPrimary && workerCount > 1) {
  console.log(`\n🚀 [MASTER] Cluster Primary ${process.pid} initializing...`);
  console.log(`🔥 Booting ${workerCount} multi-core workers...`);

  for (let i = 0; i < workerCount; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.error(`❌ [WORKER] ${worker.process.pid} crashed. Instantly spawning replacement...`);
    cluster.fork();
  });
} else {
  start();
}
