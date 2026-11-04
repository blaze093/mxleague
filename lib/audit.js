// ============================================
// REE CLASS — Security events + admin audit trail
// ============================================
// Writes to Supabase when the optional admin-upgrade.sql schema exists.
// Falls back to a bounded in-memory buffer so the UI still shows real
// events (for the current process) during a partial deployment.

const crypto = require('crypto');
const supabase = require('./supabase');

const MAX_MEMORY_EVENTS = 200;
const DEDUPE_WINDOW_MS = 8000;

const memorySecurityEvents = [];
const memoryAuditEvents = [];
const recentKeys = new Map();

function isMissingTableError(error) {
  if (!error) return false;
  if (['42P01', 'PGRST205', 'PGRST202'].includes(error.code)) return true;
  const message = String(error.message || '').toLowerCase();
  return message.includes('could not find the table') ||
    message.includes('schema cache') ||
    message.includes('does not exist');
}

function requestMeta(request) {
  if (!request) return { ip: null, userAgent: null, path: null };
  const forwarded = String(request.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return {
    ip: forwarded || request.ip || null,
    userAgent: String(request.headers?.['user-agent'] || '').slice(0, 300) || null,
    path: String(request.url || '').split('?')[0].slice(0, 240) || null
  };
}

function shouldDedupe(key, windowMs = DEDUPE_WINDOW_MS) {
  const now = Date.now();
  const last = recentKeys.get(key) || 0;
  if (now - last < windowMs) return true;
  recentKeys.set(key, now);
  if (recentKeys.size > 500) {
    for (const [k, at] of recentKeys) {
      if (now - at > windowMs * 4) recentKeys.delete(k);
    }
  }
  return false;
}

function pushMemory(target, row) {
  target.unshift(row);
  if (target.length > MAX_MEMORY_EVENTS) target.length = MAX_MEMORY_EVENTS;
}

async function logSecurityEvent({
  eventType,
  severity = 'info',
  email = null,
  request = null,
  details = {},
  dedupeKey = null,
  dedupeWindowMs = DEDUPE_WINDOW_MS
}) {
  const type = String(eventType || '').trim();
  if (!type) return null;

  const meta = requestMeta(request);
  const dedupe = dedupeKey || `${type}|${meta.ip || ''}|${meta.path || ''}`;
  if (shouldDedupe(dedupe, dedupeWindowMs)) return null;

  const row = {
    id: crypto.randomUUID(),
    event_type: type,
    severity: ['info', 'warning', 'critical'].includes(severity) ? severity : 'info',
    email: email ? String(email).slice(0, 200) : null,
    ip: meta.ip,
    user_agent: meta.userAgent,
    path: meta.path,
    details: details && typeof details === 'object' ? details : {},
    resolved: false,
    created_at: new Date().toISOString()
  };

  try {
    const { data, error } = await supabase
      .from('security_events')
      .insert({
        event_type: row.event_type,
        severity: row.severity,
        email: row.email,
        ip: row.ip,
        user_agent: row.user_agent,
        path: row.path,
        details: row.details
      })
      .select('*')
      .single();

    if (error) {
      if (isMissingTableError(error)) pushMemory(memorySecurityEvents, row);
      else console.error('Security event insert error:', error.message);
      return row;
    }
    return data;
  } catch (err) {
    if (isMissingTableError(err)) pushMemory(memorySecurityEvents, row);
    else console.error('Security event exception:', err.message);
    return row;
  }
}

async function logAudit({
  admin = null,
  action,
  targetType = null,
  targetId = null,
  details = {},
  request = null
}) {
  const name = String(action || '').trim();
  if (!name) return null;

  const meta = requestMeta(request);
  const row = {
    id: crypto.randomUUID(),
    admin_id: admin?.id || null,
    admin_name: admin?.name || admin?.email || 'Admin',
    action: name,
    target_type: targetType ? String(targetType).slice(0, 60) : null,
    target_id: targetId ? String(targetId).slice(0, 120) : null,
    details: details && typeof details === 'object' ? details : {},
    ip: meta.ip,
    user_agent: meta.userAgent,
    created_at: new Date().toISOString()
  };

  try {
    const { data, error } = await supabase
      .from('admin_audit_log')
      .insert({
        admin_id: row.admin_id,
        admin_name: row.admin_name,
        action: row.action,
        target_type: row.target_type,
        target_id: row.target_id,
        details: row.details,
        ip: row.ip,
        user_agent: row.user_agent
      })
      .select('*')
      .single();

    if (error) {
      if (isMissingTableError(error)) pushMemory(memoryAuditEvents, row);
      else console.error('Audit insert error:', error.message);
      return row;
    }
    return data;
  } catch (err) {
    if (isMissingTableError(err)) pushMemory(memoryAuditEvents, row);
    else console.error('Audit exception:', err.message);
    return row;
  }
}

function getMemorySecurityEvents() {
  return [...memorySecurityEvents];
}

function getMemoryAuditEvents() {
  return [...memoryAuditEvents];
}

// Used only while security_events is not installed. The in-memory buffer is
// per-process, so this keeps the dashboard usable during rollout.
function resolveMemorySecurityEvent(id, admin, resolved = true) {
  const row = memorySecurityEvents.find(event => event.id === id);
  if (!row) return null;
  row.resolved = Boolean(resolved);
  row.resolved_by = admin?.id || null;
  row.resolved_at = resolved ? new Date().toISOString() : null;
  return { ...row };
}

module.exports = {
  isMissingTableError,
  requestMeta,
  logSecurityEvent,
  logAudit,
  getMemorySecurityEvents,
  getMemoryAuditEvents,
  resolveMemorySecurityEvent
};
