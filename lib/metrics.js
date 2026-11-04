// ============================================
// REE CLASS — In-process API performance metrics
// ============================================
// Lightweight, dependency-free metrics used by the admin System panel.
// Keeps only bounded samples so a long-running process cannot leak memory.

const MAX_ROUTES = 200;
const MAX_LATENCY_SAMPLES = 600;
const MAX_ERRORS = 80;
const RECENT_WINDOW_MS = 60 * 1000;

const state = {
  startedAt: Date.now(),
  totalRequests: 0,
  totalErrors: 0,
  routes: new Map(), // route -> { count, errors, totalMs, maxMs, lastStatus, lastAt }
  statusCounts: new Map(),
  latencies: [], // { at, ms, route, status }
  recent: [], // { at, status, ms }
  errors: []
};

function normalizeRoute(request) {
  const route = request.routeOptions?.url || request.routerPath;
  if (route && route !== '*') return route;
  return String(request.url || '/')
    .split('?')[0]
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\/\d+(?=\/|$)/g, '/:n')
    .slice(0, 160);
}

function trimRecent(now) {
  while (state.recent.length && now - state.recent[0].at > RECENT_WINDOW_MS) {
    state.recent.shift();
  }
}

function recordRequest(request, reply, durationMs) {
  const now = Date.now();
  const route = normalizeRoute(request);
  const status = reply.statusCode || 200;
  const ms = Math.max(0, Math.round(Number(durationMs) || 0));

  state.totalRequests += 1;
  if (status >= 500) state.totalErrors += 1;

  const entry = state.routes.get(route) || {
    route,
    count: 0,
    errors: 0,
    totalMs: 0,
    maxMs: 0,
    lastStatus: status,
    lastAt: now
  };
  entry.count += 1;
  entry.totalMs += ms;
  entry.maxMs = Math.max(entry.maxMs, ms);
  entry.lastStatus = status;
  entry.lastAt = now;
  if (status >= 500) entry.errors += 1;
  state.routes.set(route, entry);

  // Keep the route map bounded.
  if (state.routes.size > MAX_ROUTES) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [key, value] of state.routes) {
      if (value.lastAt < oldestAt) {
        oldestAt = value.lastAt;
        oldestKey = key;
      }
    }
    if (oldestKey) state.routes.delete(oldestKey);
  }

  state.statusCounts.set(status, (state.statusCounts.get(status) || 0) + 1);
  state.latencies.push({ at: now, ms, route, status });
  if (state.latencies.length > MAX_LATENCY_SAMPLES) state.latencies.shift();
  state.recent.push({ at: now, status, ms });
  trimRecent(now);
}

function recordError(error, request) {
  state.errors.unshift({
    at: new Date().toISOString(),
    message: String(error?.message || error || 'Unknown error').slice(0, 500),
    code: error?.code || null,
    status: error?.statusCode || 500,
    method: request?.method || null,
    path: String(request?.url || '').split('?')[0].slice(0, 240)
  });
  if (state.errors.length > MAX_ERRORS) state.errors.length = MAX_ERRORS;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function getMetrics() {
  const now = Date.now();
  trimRecent(now);

  const latencies = state.latencies.map(item => item.ms);
  const routeRows = [...state.routes.values()]
    .map(item => ({
      route: item.route,
      count: item.count,
      errors: item.errors,
      avg_ms: item.count ? Math.round((item.totalMs / item.count) * 10) / 10 : 0,
      max_ms: item.maxMs,
      last_status: item.lastStatus,
      last_at: new Date(item.lastAt).toISOString()
    }))
    .sort((a, b) => b.count - a.count);

  const statusCounts = {};
  for (const [status, count] of state.statusCounts) statusCounts[status] = count;

  const errorRate = state.totalRequests
    ? Math.round((state.totalErrors / state.totalRequests) * 10000) / 100
    : 0;

  return {
    started_at: new Date(state.startedAt).toISOString(),
    uptime_seconds: Math.floor((now - state.startedAt) / 1000),
    total_requests: state.totalRequests,
    total_errors: state.totalErrors,
    error_rate_percent: errorRate,
    requests_last_minute: state.recent.length,
    avg_latency_ms: latencies.length
      ? Math.round((latencies.reduce((a, b) => a + b, 0) / latencies.length) * 10) / 10
      : 0,
    p95_latency_ms: percentile(latencies, 95),
    p99_latency_ms: percentile(latencies, 99),
    status_counts: statusCounts,
    routes: routeRows.slice(0, 12),
    errors: state.errors.slice(0, 30),
    memory: {
      rss_mb: Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10,
      heap_used_mb: Math.round((process.memoryUsage().heapUsed / (1024 * 1024)) * 10) / 10
    }
  };
}

module.exports = {
  recordRequest,
  recordError,
  getMetrics
};
