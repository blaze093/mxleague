// ============================================
// REE CLASS — Admin security & audit API
// ============================================
// Real security events recorded by the API (failed logins, expired admin
// tokens, rate limits, scanner paths) plus the admin audit trail.

const supabase = require('../lib/supabase');
const { requireAdminPermission } = require('../lib/auth');
const {
  logAudit,
  isMissingTableError,
  getMemorySecurityEvents,
  getMemoryAuditEvents,
  resolveMemorySecurityEvent
} = require('../lib/audit');
const { parseRange } = require('../lib/analytics');

const SEVERITIES = new Set(['info', 'warning', 'critical']);
const MAX_PAGE = 100;
const MAX_OVERVIEW_ROWS = 20000;

function invalidDate(value) {
  if (!value) return false;
  return Number.isNaN(new Date(String(value)).getTime());
}

function clampInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function safeSearch(value) {
  return String(value || '')
    .replace(/[%,()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function parseBool(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(text)) return true;
  if (['0', 'false', 'no'].includes(text)) return false;
  return null;
}

function filterMemory(rows, { from, to, severity, type, resolved, search }) {
  const query = String(search || '').toLowerCase();
  return rows
    .filter(row => {
      const at = String(row.created_at || '');
      if (from && at < from) return false;
      if (to && at >= to) return false;
      if (severity && row.severity !== severity) return false;
      if (type && row.event_type !== type) return false;
      if (resolved !== null && resolved !== undefined && Boolean(row.resolved) !== resolved) return false;
      if (query) {
        const haystack = `${row.email || ''} ${row.ip || ''} ${row.path || ''} ${row.event_type || ''}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    })
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

async function fetchBounded({ range, severity, type, resolved, search, maxRows = MAX_OVERVIEW_ROWS }) {
  const pageSize = 1000;
  const rows = [];
  let offset = 0;
  let truncated = false;

  while (offset < maxRows) {
    let query = supabase
      .from('security_events')
      .select('id, event_type, severity, email, ip, user_agent, path, details, resolved, resolved_at, created_at')
      .gte('created_at', range.from)
      .lt('created_at', range.to)
      .order('created_at', { ascending: false })
      .range(offset, offset + pageSize - 1);

    if (severity) query = query.eq('severity', severity);
    if (type) query = query.eq('event_type', type);
    if (resolved === true || resolved === false) query = query.eq('resolved', resolved);
    if (search) query = query.or(`email.ilike.%${search}%,ip.ilike.%${search}%,path.ilike.%${search}%`);

    const { data, error } = await query;
    if (error) throw error;
    const page = data || [];
    rows.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }

  if (rows.length >= maxRows) truncated = true;
  return { rows, truncated };
}

function countBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

function buildSeries(rows, range) {
  const stepMs = range.bucket === 'hour' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const start = new Date(range.from);
  const end = new Date(range.to);
  if (range.bucket === 'hour') start.setUTCMinutes(0, 0, 0);
  else start.setUTCHours(0, 0, 0, 0);

  const buckets = [];
  const cursor = new Date(start);
  let guard = 0;
  while (cursor.getTime() < end.getTime() && guard < 500) {
    buckets.push({
      bucket: cursor.toISOString(),
      label: range.bucket === 'hour'
        ? cursor.toISOString().slice(11, 16)
        : cursor.toISOString().slice(5, 10),
      total: 0,
      critical: 0,
      warning: 0,
      info: 0
    });
    cursor.setTime(cursor.getTime() + stepMs);
    guard += 1;
  }

  const index = new Map(buckets.map(item => [item.bucket.slice(0, range.bucket === 'hour' ? 13 : 10), item]));
  for (const row of rows) {
    const key = String(row.created_at).slice(0, range.bucket === 'hour' ? 13 : 10);
    const item = index.get(key);
    if (!item) continue;
    item.total += 1;
    if (row.severity === 'critical') item.critical += 1;
    else if (row.severity === 'warning') item.warning += 1;
    else item.info += 1;
  }
  return buckets;
}

function shapeEvent(row) {
  return {
    id: row.id,
    event_type: row.event_type,
    severity: row.severity,
    email: row.email || null,
    ip: row.ip || null,
    user_agent: row.user_agent || null,
    path: row.path || null,
    details: row.details || {},
    resolved: Boolean(row.resolved),
    resolved_at: row.resolved_at || null,
    created_at: row.created_at
  };
}

async function adminSecurityRoutes(fastify) {
  fastify.addHook('onSend', async (request, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // GET /api/admin/security/overview?from=&to=&bucket=
  fastify.get('/overview', { preHandler: [requireAdminPermission('security')] }, async (request, reply) => {
    if (invalidDate(request.query.from) || invalidDate(request.query.to)) {
      return reply.status(400).send({ error: 'Invalid date range. Use ISO dates or YYYY-MM-DD.' });
    }
    const range = parseRange(request.query, { defaultDays: 7 });

    try {
      const [probe, totalProbe, unresolvedProbe, auditProbe] = await Promise.all([
        supabase.from('security_events').select('id').limit(1),
        supabase.from('security_events').select('*', { count: 'exact', head: true }).gte('created_at', range.from).lt('created_at', range.to),
        supabase.from('security_events').select('*', { count: 'exact', head: true }).eq('resolved', false),
        supabase
          .from('admin_audit_log')
          .select('id, admin_name, action, target_type, target_id, details, created_at')
          .order('created_at', { ascending: false })
          .limit(10)
      ]);

      const tableMissing = isMissingTableError(probe.error);
      const totalCount = totalProbe.error ? null : totalProbe.count;
      const unresolvedCount = unresolvedProbe.error ? null : unresolvedProbe.count;
      const auditRows = auditProbe.error ? [] : auditProbe.data || [];

      let rows;
      let truncated = false;
      let source;
      if (tableMissing) {
        rows = filterMemory(getMemorySecurityEvents(), {
          from: range.from,
          to: range.to,
          severity: null,
          type: null,
          resolved: null,
          search: ''
        });
        source = 'memory';
      } else {
        if (probe.error) {
          console.error('Security overview error:', probe.error);
          return reply.status(500).send({ error: 'Failed to load security overview' });
        }
        const fetched = await fetchBounded({ range });
        rows = fetched.rows;
        truncated = fetched.truncated;
        source = 'database';
      }

      const severity = countBy(rows, row => row.severity || 'info');
      const types = countBy(rows, row => row.event_type);
      const ipMap = new Map();
      for (const row of rows) {
        if (!row.ip) continue;
        const entry = ipMap.get(row.ip) || { ip: row.ip, count: 0, critical: 0, last_seen: null, last_path: null };
        entry.count += 1;
        if (row.severity === 'critical') entry.critical += 1;
        if (!entry.last_seen || String(row.created_at) > String(entry.last_seen)) {
          entry.last_seen = row.created_at;
          entry.last_path = row.path || null;
        }
        ipMap.set(row.ip, entry);
      }

      const failedLogins = rows.filter(row => row.event_type === 'admin_login_failed').length;
      const rateLimits = rows.filter(row => row.event_type === 'rate_limit_exceeded').length;
      const suspicious = rows.filter(row => row.event_type === 'suspicious_request').length;
      const authFailures = rows.filter(row => row.event_type === 'admin_auth_failed').length;
      const critical = rows.filter(row => row.severity === 'critical').length;
      const warning = rows.filter(row => row.severity === 'warning').length;
      const info = rows.filter(row => row.severity === 'info').length;

      return {
        range,
        ready: !tableMissing,
        source,
        truncated,
        totals: {
          events: totalCount == null ? rows.length : totalCount,
          loaded: rows.length,
          unresolved: unresolvedCount == null ? rows.filter(row => !row.resolved).length : unresolvedCount,
          critical,
          warning,
          info,
          unique_ips: ipMap.size,
          failed_logins: failedLogins,
          rate_limits: rateLimits,
          suspicious_requests: suspicious,
          admin_auth_failures: authFailures
        },
        severity: severity.map(item => ({ name: item.name, count: item.count })),
        types: types.slice(0, 12),
        top_ips: [...ipMap.values()]
          .sort((a, b) => b.count - a.count || b.critical - a.critical)
          .slice(0, 10),
        series: buildSeries(rows, range),
        recent: rows.slice(0, 15).map(shapeEvent),
        audit_recent: auditRows,
        audit_ready: !auditProbe.error
      };
    } catch (err) {
      console.error('Security overview exception:', err);
      return reply.status(500).send({ error: 'Failed to load security overview' });
    }
  });

  // GET /api/admin/security/events?severity=&type=&resolved=&from=&to=&search=&limit=&offset=
  fastify.get('/events', { preHandler: [requireAdminPermission('security')] }, async (request, reply) => {
    if (invalidDate(request.query.from) || invalidDate(request.query.to)) {
      return reply.status(400).send({ error: 'Invalid date range. Use ISO dates or YYYY-MM-DD.' });
    }
    const range = parseRange(request.query, { defaultDays: 30 });
    const severity = SEVERITIES.has(String(request.query.severity || '')) ? String(request.query.severity) : null;
    const type = safeSearch(request.query.type) || null;
    const resolved = parseBool(request.query.resolved);
    const search = safeSearch(request.query.search);
    const limit = clampInt(request.query.limit, 25, 1, MAX_PAGE);
    const offset = clampInt(request.query.offset, 0, 0, 100000);

    try {
      let query = supabase
        .from('security_events')
        .select('id, event_type, severity, email, ip, user_agent, path, details, resolved, resolved_at, created_at', { count: 'exact' })
        .gte('created_at', range.from)
        .lt('created_at', range.to)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
      if (severity) query = query.eq('severity', severity);
      if (type) query = query.eq('event_type', type);
      if (resolved === true || resolved === false) query = query.eq('resolved', resolved);
      if (search) query = query.or(`email.ilike.%${search}%,ip.ilike.%${search}%,path.ilike.%${search}%`);

      const { data, error, count } = await query;

      if (error) {
        if (!isMissingTableError(error)) {
          console.error('Security events error:', error);
          return reply.status(500).send({ error: 'Failed to load security events' });
        }
        const memory = filterMemory(getMemorySecurityEvents(), {
          from: range.from,
          to: range.to,
          severity,
          type,
          resolved,
          search
        });
        return {
          range,
          ready: false,
          source: 'memory',
          events: memory.slice(offset, offset + limit).map(shapeEvent),
          total: memory.length,
          limit,
          offset,
          has_more: offset + limit < memory.length
        };
      }

      const events = (data || []).map(shapeEvent);
      return {
        range,
        ready: true,
        source: 'database',
        events,
        total: count || 0,
        limit,
        offset,
        has_more: offset + events.length < (count || 0)
      };
    } catch (err) {
      console.error('Security events exception:', err);
      return reply.status(500).send({ error: 'Failed to load security events' });
    }
  });

  // POST /api/admin/security/events/:id/resolve
  fastify.post('/events/:id/resolve', { preHandler: [requireAdminPermission('security')] }, async (request, reply) => {
    const resolved = parseBool((request.body || {}).resolved);
    const nextResolved = resolved === null ? true : resolved;

    try {
      const { data, error } = await supabase
        .from('security_events')
        .update({
          resolved: nextResolved,
          resolved_by: request.admin.id,
          resolved_at: nextResolved ? new Date().toISOString() : null
        })
        .eq('id', request.params.id)
        .select('id, event_type, severity, resolved, resolved_at')
        .maybeSingle();

      if (error) {
        if (!isMissingTableError(error)) {
          console.error('Security resolve error:', error);
          return reply.status(500).send({ error: 'Failed to update security event' });
        }
        const memory = resolveMemorySecurityEvent(request.params.id, request.admin, nextResolved);
        if (!memory) return reply.status(404).send({ error: 'Security event not found' });
        await logAudit({
          admin: request.admin,
          action: 'security.resolve',
          targetType: 'security_event',
          targetId: memory.id,
          details: { resolved: nextResolved, fallback: true },
          request
        });
        return { event: memory, ready: false };
      }

      if (!data) return reply.status(404).send({ error: 'Security event not found' });

      await logAudit({
        admin: request.admin,
        action: 'security.resolve',
        targetType: 'security_event',
        targetId: data.id,
        details: { resolved: nextResolved, event_type: data.event_type, severity: data.severity },
        request
      });
      return { event: data, ready: true };
    } catch (err) {
      console.error('Security resolve exception:', err);
      return reply.status(500).send({ error: 'Failed to update security event' });
    }
  });

  // POST /api/admin/security/events/resolve — bulk resolve up to 50 events
  fastify.post('/events/resolve', { preHandler: [requireAdminPermission('security')] }, async (request, reply) => {
    const ids = Array.isArray((request.body || {}).ids)
      ? [...new Set((request.body || {}).ids.map(id => String(id || '').trim()).filter(Boolean))].slice(0, 50)
      : [];
    if (!ids.length) return reply.status(400).send({ error: 'Select at least one event' });

    try {
      const { data, error } = await supabase
        .from('security_events')
        .update({
          resolved: true,
          resolved_by: request.admin.id,
          resolved_at: new Date().toISOString()
        })
        .in('id', ids)
        .select('id');

      if (error) {
        if (!isMissingTableError(error)) {
          console.error('Security bulk resolve error:', error);
          return reply.status(500).send({ error: 'Failed to update security events' });
        }
        const updated = ids.map(id => resolveMemorySecurityEvent(id, request.admin, true)).filter(Boolean);
        await logAudit({
          admin: request.admin,
          action: 'security.resolve_bulk',
          targetType: 'security_event',
          targetId: null,
          details: { count: updated.length, fallback: true },
          request
        });
        return { updated: updated.length, ready: false };
      }

      await logAudit({
        admin: request.admin,
        action: 'security.resolve_bulk',
        targetType: 'security_event',
        targetId: null,
        details: { count: (data || []).length, ids },
        request
      });
      return { updated: (data || []).length, ready: true };
    } catch (err) {
      console.error('Security bulk resolve exception:', err);
      return reply.status(500).send({ error: 'Failed to update security events' });
    }
  });

  // GET /api/admin/security/audit?admin_id=&action=&target_type=&search=&from=&to=&limit=&offset=
  fastify.get('/audit', { preHandler: [requireAdminPermission('security')] }, async (request, reply) => {
    if (invalidDate(request.query.from) || invalidDate(request.query.to)) {
      return reply.status(400).send({ error: 'Invalid date range. Use ISO dates or YYYY-MM-DD.' });
    }
    const range = parseRange(request.query, { defaultDays: 30 });
    const adminId = safeSearch(request.query.admin_id);
    const action = safeSearch(request.query.action);
    const targetType = safeSearch(request.query.target_type);
    const search = safeSearch(request.query.search);
    const limit = clampInt(request.query.limit, 25, 1, MAX_PAGE);
    const offset = clampInt(request.query.offset, 0, 0, 100000);

    try {
      let query = supabase
        .from('admin_audit_log')
        .select('id, admin_id, admin_name, action, target_type, target_id, details, ip, created_at', { count: 'exact' })
        .gte('created_at', range.from)
        .lt('created_at', range.to)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
      if (adminId) query = query.eq('admin_id', adminId);
      if (action) query = query.eq('action', action);
      if (targetType) query = query.eq('target_type', targetType);
      if (search) query = query.or(`admin_name.ilike.%${search}%,action.ilike.%${search}%,target_id.ilike.%${search}%`);

      const { data, error, count } = await query;

      if (error) {
        if (!isMissingTableError(error)) {
          console.error('Audit list error:', error);
          return reply.status(500).send({ error: 'Failed to load audit trail' });
        }
        const memory = getMemoryAuditEvents()
          .filter(row => {
            const at = String(row.created_at || '');
            if (at < range.from || at >= range.to) return false;
            if (adminId && row.admin_id !== adminId) return false;
            if (action && row.action !== action) return false;
            if (targetType && row.target_type !== targetType) return false;
            if (search) {
              const haystack = `${row.admin_name || ''} ${row.action || ''} ${row.target_id || ''}`.toLowerCase();
              if (!haystack.includes(search.toLowerCase())) return false;
            }
            return true;
          })
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        return {
          range,
          ready: false,
          source: 'memory',
          events: memory.slice(offset, offset + limit),
          total: memory.length,
          limit,
          offset,
          has_more: offset + limit < memory.length
        };
      }

      return {
        range,
        ready: true,
        source: 'database',
        events: data || [],
        total: count || 0,
        limit,
        offset,
        has_more: offset + (data || []).length < (count || 0)
      };
    } catch (err) {
      console.error('Audit list exception:', err);
      return reply.status(500).send({ error: 'Failed to load audit trail' });
    }
  });
}

module.exports = adminSecurityRoutes;
