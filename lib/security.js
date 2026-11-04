// ============================================
// REE CLASS — Threat detection helpers
// ============================================
const supabase = require('./supabase');
const {
  logSecurityEvent,
  isMissingTableError,
  getMemorySecurityEvents,
  requestMeta
} = require('./audit');

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_PER_IDENTITY = 8;
const MAX_FAILED_PER_IP = 20;

function memoryFailures({ email, ip }) {
  const since = Date.now() - LOGIN_WINDOW_MS;
  return getMemorySecurityEvents().filter(event => {
    if (event.event_type !== 'admin_login_failed') return false;
    if (new Date(event.created_at).getTime() < since) return false;
    const emailMatch = email && String(event.email || '').toLowerCase() === String(email).toLowerCase();
    const ipMatch = ip && event.ip === ip;
    return emailMatch || ipMatch;
  });
}

async function countRecentFailures({ email, ip }) {
  const since = new Date(Date.now() - LOGIN_WINDOW_MS).toISOString();
  let byEmail = 0;
  let byIp = 0;

  if (email) {
    const { count, error } = await supabase
      .from('security_events')
      .select('*', { count: 'exact', head: true })
      .eq('event_type', 'admin_login_failed')
      .eq('email', String(email).toLowerCase())
      .gte('created_at', since);
    if (!error) byEmail = count || 0;
    else if (!isMissingTableError(error)) console.error('Login lockout lookup error:', error.message);
  }

  if (ip) {
    const { count, error } = await supabase
      .from('security_events')
      .select('*', { count: 'exact', head: true })
      .eq('event_type', 'admin_login_failed')
      .eq('ip', ip)
      .gte('created_at', since);
    if (!error) byIp = count || 0;
  }

  // If the security table is not installed, use the in-memory buffer.
  if (!byEmail && !byIp) {
    const memory = memoryFailures({ email, ip });
    byEmail = memory.filter(event => email && String(event.email || '').toLowerCase() === String(email).toLowerCase()).length;
    byIp = memory.filter(event => ip && event.ip === ip).length;
  }

  return { byEmail, byIp };
}

async function checkLoginLockout(email, ip) {
  const { byEmail, byIp } = await countRecentFailures({ email, ip });
  const locked = byEmail >= MAX_FAILED_PER_IDENTITY || byIp >= MAX_FAILED_PER_IP;
  return {
    locked,
    failedByEmail: byEmail,
    failedByIp: byIp,
    retryAfterSeconds: locked ? Math.ceil(LOGIN_WINDOW_MS / 1000) : 0
  };
}

async function recordLoginFailure({ email, request, reason = 'invalid_credentials' }) {
  const meta = requestMeta(request);
  return logSecurityEvent({
    eventType: 'admin_login_failed',
    severity: 'warning',
    email,
    request,
    details: { reason },
    dedupeKey: `admin_login_failed|${email || ''}|${meta.ip || ''}`,
    dedupeWindowMs: 1500
  });
}

async function recordLoginSuccess({ email, request }) {
  return logSecurityEvent({
    eventType: 'admin_login_success',
    severity: 'info',
    email,
    request,
    details: { reason: 'authenticated' },
    dedupeKey: `admin_login_success|${email || ''}|${requestMeta(request).ip || ''}`,
    dedupeWindowMs: 2000
  });
}

async function recordAdminAuthFailure(request) {
  return logSecurityEvent({
    eventType: 'admin_auth_failed',
    severity: 'warning',
    request,
    details: { reason: 'invalid_or_expired_token' },
    dedupeKey: `admin_auth_failed|${requestMeta(request).ip || ''}|${requestMeta(request).path || ''}`,
    dedupeWindowMs: 30000
  });
}

async function recordRateLimit(request) {
  return logSecurityEvent({
    eventType: 'rate_limit_exceeded',
    severity: 'warning',
    request,
    details: {
      method: request?.method || null,
      reason: 'request_rate_exceeded'
    },
    dedupeKey: `rate_limit|${requestMeta(request).ip || ''}|${requestMeta(request).path || ''}`,
    dedupeWindowMs: 30000
  });
}

function isSuspiciousPath(pathname) {
  const path = String(pathname || '').toLowerCase();
  return [
    '/.env', '/.git', '/wp-admin', '/wp-login', '/phpmyadmin',
    '/etc/passwd', '/actuator', '/server-status', '/config.php',
    '/backup', '/.aws', '/vendor/phpunit', '/cgi-bin', '/admin.php'
  ].some(fragment => path.includes(fragment)) ||
    path.includes('../') ||
    path.includes('..%2f') ||
    path.includes('%2e%2e');
}

async function recordSuspiciousRequest(request) {
  const meta = requestMeta(request);
  return logSecurityEvent({
    eventType: 'suspicious_request',
    severity: 'warning',
    request,
    details: {
      method: request?.method || null,
      path: meta.path,
      reason: 'known_scanner_path'
    },
    dedupeKey: `suspicious|${meta.ip || ''}|${meta.path || ''}`,
    dedupeWindowMs: 60000
  });
}

module.exports = {
  checkLoginLockout,
  recordLoginFailure,
  recordLoginSuccess,
  recordAdminAuthFailure,
  recordRateLimit,
  recordSuspiciousRequest,
  isSuspiciousPath,
  MAX_FAILED_PER_IDENTITY,
  MAX_FAILED_PER_IP
};
