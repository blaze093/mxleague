// ============================================
// REE CLASS — Dashboard Stats Route (Optimized)
// ============================================
const os = require('os');
const supabase = require('../lib/supabase');
const cache = require('../lib/cache');
const { requireAdminPermission } = require('../lib/auth');
const { getMetrics } = require('../lib/metrics');
const {
  isMissingTableError,
  getMemoryAuditEvents,
  getMemorySecurityEvents
} = require('../lib/audit');

async function safeCount(query) {
  try {
    const result = await query;
    if (result.error) return null;
    return result.count || 0;
  } catch {
    return null;
  }
}

// HEAD count queries can return a null count without an error when a table is
// missing. Probe with a real select so "wallet ready" reflects the schema.
async function tableReady(query) {
  try {
    const result = await query;
    return !result.error;
  } catch {
    return false;
  }
}

async function dashboardRoutes(fastify) {
  // GET /api/dashboard/stats — Dashboard permission required (cached 15s)
  fastify.get('/stats', { preHandler: [requireAdminPermission('dashboard')] }, async (request, reply) => {
    const cached = cache.get('dash:stats');
    if (cached) return cached;

    try {
      const [
        tournaments,
        completed,
        users,
        bookings,
        pendingTopups,
        pendingWithdrawals,
        topupImages,
        legacyApproved,
        legacyPending,
        legacyImages,
        walletReadyProbe
      ] = await Promise.all([
        safeCount(supabase.from('tournaments').select('*', { count: 'exact', head: true })),
        safeCount(supabase.from('tournaments').select('*', { count: 'exact', head: true }).eq('status', 'completed')),
        safeCount(supabase.from('users').select('*', { count: 'exact', head: true })),
        safeCount(supabase.from('bookings').select('*', { count: 'exact', head: true }).eq('status', 'confirmed')),
        safeCount(supabase.from('topup_requests').select('*', { count: 'exact', head: true }).eq('status', 'pending')),
        safeCount(supabase.from('withdrawal_requests').select('*', { count: 'exact', head: true }).eq('status', 'pending')),
        safeCount(supabase.from('topup_requests').select('*', { count: 'exact', head: true }).not('screenshot_url', 'is', null)),
        safeCount(supabase.from('registrations').select('*', { count: 'exact', head: true }).eq('status', 'approved')),
        safeCount(supabase.from('registrations').select('*', { count: 'exact', head: true }).eq('status', 'pending')),
        safeCount(supabase.from('registrations').select('*', { count: 'exact', head: true }).not('screenshot_url', 'is', null)),
        tableReady(supabase.from('users').select('id').limit(1))
      ]);

      const walletReady = walletReadyProbe === true;
      const result = {
        tournaments: tournaments || 0,
        completed: completed || 0,
        pending: walletReady ? (pendingTopups || 0) + (pendingWithdrawals || 0) : (legacyPending || 0),
        teams: (walletReady ? (bookings || 0) : 0) + (legacyApproved || 0),
        images: (walletReady ? (topupImages || 0) : 0) + (legacyImages || 0),
        users: walletReady ? (users || 0) : 0,
        bookings: walletReady ? (bookings || 0) : 0,
        legacy_approved: legacyApproved || 0,
        pending_topups: walletReady ? (pendingTopups || 0) : 0,
        pending_withdrawals: walletReady ? (pendingWithdrawals || 0) : 0,
        wallet_ready: walletReady
      };

      cache.set('dash:stats', result, 15);
      return result;
    } catch (err) {
      console.error('Dashboard stats error:', err);
      return reply.status(500).send({ error: 'Failed to load stats' });
    }
  });

  // CPU load tracking (continuous, zero-cost)
  let lastCpuInfo = { idle: 0, total: 0 };

  function updateCpuLoad() {
    const cpus = os.cpus();
    let idle = 0;
    let total = 0;
    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        total += cpu.times[type];
      }
      idle += cpu.times.idle;
    });

    if (lastCpuInfo.total === 0) {
      lastCpuInfo = { idle, total };
      return 0;
    }

    const idleDiff = idle - lastCpuInfo.idle;
    const totalDiff = total - lastCpuInfo.total;
    lastCpuInfo = { idle, total };

    if (totalDiff === 0) return 0;
    return 100 - ((idleDiff / totalDiff) * 100);
  }

  // GET /api/dashboard/system — System permission required (cached 10s + stale fallback)
  fastify.get('/system', { preHandler: [requireAdminPermission('system')] }, async (request, reply) => {
    const cached = cache.get('dash:system');
    if (cached) return cached;

    try {
      const [tournsRes, legacyRegsRes, usersRes, bookingsRes, walletRes, dbPingRes] = await Promise.all([
        supabase.from('tournaments').select('id, name, entry_fee, prize_pool, max_teams, status'),
        supabase.from('registrations').select('tournament_id').eq('status', 'approved'),
        supabase.from('users').select('*', { count: 'exact', head: true }),
        supabase.from('bookings').select('*', { count: 'exact', head: true }).eq('status', 'confirmed'),
        supabase.rpc('admin_wallet_summary'),
        (async () => {
          return new Promise((resolve) => {
            const net = require('net');
            const start = Date.now();
            const host = process.env.SUPABASE_URL.replace('https://', '').replace('/', '');
            const socket = new net.Socket();
            socket.setTimeout(2500);

            socket.on('connect', () => {
              const latency = Date.now() - start;
              socket.destroy();
              resolve({ status: 'connected', latency });
            });

            socket.on('timeout', () => {
              socket.destroy();
              resolve({ status: 'timeout', latency: 0 });
            });

            socket.on('error', () => {
              resolve({ status: 'disconnected', latency: 0 });
            });

            socket.connect(443, host);
          });
        })()
      ]);

      const tournamentsArray = tournsRes.data || [];
      const legacyArray = legacyRegsRes.data || [];
      const wallet = walletRes && !walletRes.error ? (walletRes.data || null) : null;
      const walletReady = Boolean(wallet);
      const registeredUsers = usersRes.error ? 0 : (usersRes.count || 0);
      const bookingCount = bookingsRes.error ? 0 : (bookingsRes.count || 0);

      let legacyRevenue = 0;
      let totalPrize = 0;
      let liveCount = 0;
      let completedCount = 0;
      let totalCapacity = 0;

      const feeMap = {};
      tournamentsArray.forEach(t => {
        feeMap[t.id] = t.entry_fee || 0;
        totalPrize += (t.prize_pool || 0);
        totalCapacity += (t.max_teams || 0);
        if (t.status === 'live') liveCount++;
        if (t.status === 'completed') completedCount++;
      });

      legacyArray.forEach(r => {
        legacyRevenue += (feeMap[r.tournament_id] || 0);
      });

      const bookingRevenue = wallet ? Number(wallet.booking_revenue) || 0 : 0;
      const totalRevenue = bookingRevenue + legacyRevenue;
      const reservedSeats = bookingCount + legacyArray.length;
      const fillRate = totalCapacity > 0 ? ((reservedSeats / totalCapacity) * 100).toFixed(1) : 0;
      const pendingReviews = wallet
        ? (Number(wallet.pending_topups) || 0) + (Number(wallet.pending_withdrawals) || 0)
        : 0;

      const memTotal = os.totalmem();
      const memFree = os.freemem();
      const memUsed = memTotal - memFree;
      const cpus = os.cpus();
      const procMem = process.memoryUsage();

      const responseData = {
        server: {
          uptime: process.uptime(),
          os_uptime: os.uptime(),
          node_version: process.version,
          platform: os.platform(),
          cpu_cores: cpus.length,
          cpu_model: cpus[0].model,
          cpu_usage_percent: updateCpuLoad().toFixed(1),
          memory_total_gb: (memTotal / (1024 ** 3)).toFixed(2),
          memory_used_gb: (memUsed / (1024 ** 3)).toFixed(2),
          memory_usage_percent: ((memUsed / memTotal) * 100).toFixed(1),
          process_ram_mb: (procMem.rss / (1024 ** 2)).toFixed(1)
        },
        database: {
          status: dbPingRes.status,
          latency_ms: dbPingRes.latency,
          total_tournaments: tournamentsArray.length,
          active_tournaments: liveCount,
          completed_tournaments: completedCount
        },
        analytics: {
          wallet_ready: walletReady,
          registered_users: registeredUsers,
          total_bookings: bookingCount,
          legacy_entries: legacyArray.length,
          total_registrations: registeredUsers,
          approved: bookingCount,
          rejected: 0,
          approval_ratio_percent: fillRate,
          rejection_ratio_percent: 0,
          conversion_rate: fillRate,
          fill_rate_percent: fillRate,
          total_revenue: totalRevenue,
          booking_revenue: bookingRevenue,
          legacy_revenue: legacyRevenue,
          total_prize_pool: totalPrize,
          net_profit: (totalRevenue - totalPrize),
          wallet_float: wallet ? Number(wallet.wallet_balance_total) || 0 : 0,
          pending_reviews: pendingReviews,
          pending_topups: wallet ? Number(wallet.pending_topups) || 0 : 0,
          pending_withdrawals: wallet ? Number(wallet.pending_withdrawals) || 0 : 0,
          lifetime_topups: wallet ? Number(wallet.lifetime_topups) || 0 : 0,
          lifetime_withdrawals: wallet ? Number(wallet.lifetime_withdrawals) || 0 : 0
        },
        api: getMetrics()
      };

      cache.set('dash:system', responseData, 10);
      return responseData;
    } catch (err) {
      console.error('System dashboard error:', err);
      const stale = cache.get('dash:system');
      if (stale) return stale;
      return reply.status(500).send({ error: 'Failed to load system metrics' });
    }
  });

  // GET /api/dashboard/api-metrics — in-process API latency/error metrics
  fastify.get('/api-metrics', { preHandler: [requireAdminPermission('system')] }, async () => {
    return {
      ...getMetrics(),
      generated_at: new Date().toISOString()
    };
  });

  // GET /api/dashboard/errors — recent captured errors (bounded buffer)
  fastify.get('/errors', { preHandler: [requireAdminPermission('system')] }, async () => {
    const metrics = getMetrics();
    return {
      total_errors: metrics.total_errors,
      error_rate_percent: metrics.error_rate_percent,
      errors: metrics.errors,
      routes: metrics.routes.filter(route => route.errors > 0).slice(0, 10),
      generated_at: new Date().toISOString()
    };
  });

  // GET /api/dashboard/db-health — real per-table readiness + latency
  fastify.get('/db-health', { preHandler: [requireAdminPermission('system')] }, async () => {
    const tables = [
      'settings', 'admins', 'users', 'tournaments', 'registrations', 'bookings',
      'results', 'wallet_transactions', 'topup_requests', 'withdrawal_requests',
      'site_events', 'security_events', 'admin_audit_log', 'team_members'
    ];

    const probes = await Promise.all(tables.map(async (table) => {
      const start = Date.now();
      try {
        const { error } = await supabase.from(table).select('*').limit(1);
        return {
          table,
          ready: !error,
          latency_ms: Date.now() - start,
          code: error ? error.code || null : null,
          optional: ['site_events', 'security_events', 'admin_audit_log'].includes(table)
        };
      } catch (err) {
        return {
          table,
          ready: false,
          latency_ms: Date.now() - start,
          code: err.code || null,
          optional: ['site_events', 'security_events', 'admin_audit_log'].includes(table)
        };
      }
    }));

    return {
      tables: probes,
      ready: probes.filter(item => item.ready).length,
      total: probes.length,
      optional_missing: probes.filter(item => item.optional && !item.ready).map(item => item.table),
      generated_at: new Date().toISOString()
    };
  });

  // GET /api/dashboard/activity — recent admin actions + security events
  fastify.get('/activity', { preHandler: [requireAdminPermission('system')] }, async () => {
    const [auditRes, securityRes] = await Promise.all([
      supabase
        .from('admin_audit_log')
        .select('id, admin_name, action, target_type, target_id, details, ip, created_at')
        .order('created_at', { ascending: false })
        .limit(40),
      supabase
        .from('security_events')
        .select('id, event_type, severity, email, ip, path, resolved, created_at')
        .order('created_at', { ascending: false })
        .limit(30)
    ]);

    const auditMissing = isMissingTableError(auditRes.error);
    const securityMissing = isMissingTableError(securityRes.error);

    return {
      audit: auditMissing ? getMemoryAuditEvents().slice(0, 40) : (auditRes.data || []),
      security: securityMissing ? getMemorySecurityEvents().slice(0, 30) : (securityRes.data || []),
      ready: {
        audit: !auditMissing && !auditRes.error,
        security: !securityMissing && !securityRes.error
      },
      generated_at: new Date().toISOString()
    };
  });
}

module.exports = dashboardRoutes;
