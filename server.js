 //============================================
// MX League — Fastify Server Entry Point (Optimized)
// ============================================
require('dotenv').config();

const path = require('path');
const os = require('os'); // Hoisted — never require inside hot paths

const fastify = require('fastify')({
  logger: process.env.NODE_ENV === 'production' ? { level: 'error' } : true,
  disableRequestLogging: process.env.NODE_ENV === 'production',
  trustProxy: true,
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
  // CORS — strict allowlist (comma-separated origins via env var, defaults for local dev)
  const allowedOrigins = (process.env.CORS_ORIGINS || 'https://tictacarena.in')
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

  // Multipart for file uploads
  await fastify.register(require('@fastify/multipart'), {
    limits: {
      fileSize: 5 * 1024 * 1024 // 5 MB
    }
  });

  // Serve frontend static files with aggressive caching
  await fastify.register(require('@fastify/static'), {
    root: path.join(__dirname, '..'),
    prefix: '/',
    maxAge: process.env.NODE_ENV === 'production' ? '30d' : 0,
    immutable: process.env.NODE_ENV === 'production', // Browser never revalidates cached assets
    lastModified: true, // Enables 304 Not Modified responses
    dotfiles: 'deny',
    // Never expose backend source, environment files, SQL, or docs.
    allowedPath: (pathname) => {
      const p = pathname.replace(/\\/g, '/');
      return p === '/' ||
        p === '/index.html' ||
        p === '/admin.html' ||
        p === '/favicon.svg' ||
        p === '/logo.png' ||
        p.startsWith('/css/') ||
        p.startsWith('/js/');
    }
  });

  // Global error handler — never leak internal error details to clients
  fastify.setErrorHandler((error, request, reply) => {
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

  // Rate Limiting
  await fastify.register(require('@fastify/rate-limit'), {
    global: false
  });

  // Register API routes
  fastify.register(require('./routes/auth'), { prefix: '/api/auth' });
  fastify.register(require('./routes/userAuth'), { prefix: '/api/auth' });
  fastify.register(require('./routes/settings'), { prefix: '/api/settings' });
  fastify.register(require('./routes/tournaments'), { prefix: '/api/tournaments' });
  fastify.register(require('./routes/bookings'), { prefix: '/api/bookings' });
  fastify.register(require('./routes/wallet'), { prefix: '/api/wallet' });
  fastify.register(require('./routes/adminWallet'), { prefix: '/api/admin/wallets' });
  fastify.register(require('./routes/results'), { prefix: '/api/results' });
  fastify.register(require('./routes/upload'), { prefix: '/api/upload' });
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
    console.log(`\n🎮 MX League ${procType} running on http://localhost:${port}\n`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

// ============================================
// CLUSTER MODE: Multi-Core Extreme Performance
// ============================================
const cluster = require('cluster');

if (process.env.NODE_ENV === 'production' && cluster.isPrimary) {
  const numCPUs = Math.min(os.cpus().length, 2);

  console.log(`\n🚀 [MASTER] Cluster Primary ${process.pid} initializing...`);
  console.log(`🔥 Booting ${numCPUs} multi-core workers...`);

  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.error(`❌ [WORKER] ${worker.process.pid} crashed. Instantly spawning replacement...`);
    cluster.fork();
  });
} else {
  start();
}
