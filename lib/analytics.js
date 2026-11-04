// ============================================
// REE CLASS — Real analytics (no synthetic data)
// ============================================
// Uses server-side SQL aggregates when database/admin-upgrade.sql has
// been applied. Falls back to bounded, paginated reads from the base
// tables so the dashboard still shows real data during rollout.

const supabase = require('./supabase');
const { isMissingTableError } = require('./audit');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 366;
const MAX_FALLBACK_ROWS = 50000;

const memoryTraffic = [];

function recordTrafficMemory(event) {
  memoryTraffic.unshift({
    event_type: 'page_view',
    path: event.path || '/',
    session_id: event.session_id || null,
    user_id: event.user_id || null,
    referrer: event.referrer || null,
    user_agent: event.user_agent || null,
    created_at: new Date().toISOString()
  });
  if (memoryTraffic.length > 500) memoryTraffic.length = 500;
}

function getMemoryTraffic() {
  return [...memoryTraffic];
}

function parseDate(value, endOfDay = false) {
  if (!value) return null;
  const text = String(value).trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const date = new Date(dateOnly ? `${text}T00:00:00.000Z` : text);
  if (Number.isNaN(date.getTime())) return null;
  if (dateOnly && endOfDay) date.setUTCHours(23, 59, 59, 999);
  return date;
}

function parseRange(query = {}, options = {}) {
  const defaultDays = Math.min(MAX_RANGE_DAYS, Math.max(1, Number(options.defaultDays) || 30));
  const now = new Date();
  let to = parseDate(query.to, true) || now;
  let from = parseDate(query.from) || new Date(to.getTime() - defaultDays * DAY_MS);

  if (from.getTime() > to.getTime()) {
    const swap = from;
    from = to;
    to = swap;
  }

  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
    from = new Date(to.getTime() - MAX_RANGE_DAYS * DAY_MS);
  }

  const days = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / DAY_MS));
  const bucket = query.bucket === 'hour' || (query.bucket !== 'day' && days <= 2) ? 'hour' : 'day';
  const previousTo = new Date(from.getTime());
  const previousFrom = new Date(from.getTime() - (to.getTime() - from.getTime()));

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    previousFrom: previousFrom.toISOString(),
    previousTo: previousTo.toISOString(),
    days,
    bucket,
    max_days: MAX_RANGE_DAYS
  };
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeSummary(data = {}) {
  const keys = [
    'users_total', 'users_new', 'active_users', 'bookings_total', 'bookings_in_range',
    'bookings_cancelled', 'booking_revenue', 'revenue_in_range', 'topups_approved_in_range',
    'topups_pending_count', 'topups_pending_amount', 'withdrawals_approved_in_range',
    'withdrawals_pending_count', 'withdrawals_pending_amount', 'wallet_float',
    'wallet_volume_in_range', 'refunds_in_range', 'admin_credits_in_range',
    'admin_debits_in_range', 'pageviews_in_range', 'visitors_in_range', 'active_now',
    'tournaments_total', 'tournaments_live', 'tournaments_upcoming', 'tournaments_completed',
    'registrations_legacy', 'results_count', 'security_failed_logins', 'security_unresolved'
  ];
  const normalized = { ...data };
  for (const key of keys) normalized[key] = toNumber(data[key]);
  return normalized;
}

async function fetchAll(table, select, apply, maxRows = MAX_FALLBACK_ROWS) {
  const pageSize = 1000;
  let offset = 0;
  const rows = [];
  let truncated = false;

  while (offset < maxRows) {
    let query = supabase.from(table).select(select).range(offset, offset + pageSize - 1);
    if (apply) query = apply(query);
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

async function safeFetchAll(table, select, apply) {
  try {
    return await fetchAll(table, select, apply);
  } catch (error) {
    if (!isMissingTableError(error)) console.error(`Analytics fallback (${table}):`, error.message);
    return { rows: [], truncated: false, missing: isMissingTableError(error) };
  }
}

async function countRows(table, apply) {
  let query = supabase.from(table).select('*', { count: 'exact', head: true });
  if (apply) query = apply(query);
  const { count, error } = await query;
  if (error) {
    if (!isMissingTableError(error)) console.error(`Analytics count (${table}):`, error.message);
    return 0;
  }
  return count || 0;
}

async function fallbackSummary(range) {
  const from = range.from;
  const to = range.to;
  const inRange = query => query.gte('created_at', from).lt('created_at', to);
  const reviewedInRange = query => query.gte('reviewed_at', from).lt('reviewed_at', to);

  const [
    usersTotal,
    usersNew,
    activeUsers,
    bookingsTotal,
    bookingsInRange,
    bookingsCancelled,
    tournamentsTotal,
    tournamentsLive,
    tournamentsUpcoming,
    tournamentsCompleted,
    registrationsLegacy,
    resultsCount,
    pendingTopups,
    pendingWithdrawals,
    unresolvedSecurity,
    failedLogins,
    confirmedBookings,
    topups,
    withdrawals,
    pendingTopupRows,
    pendingWithdrawalRows,
    walletTx,
    pageviews,
    userBalances,
    securityProbe,
    activeSessions
  ] = await Promise.all([
    countRows('users'),
    countRows('users', inRange),
    countRows('users', query => query.gte('last_seen_at', from).lt('last_seen_at', to)),
    countRows('bookings', query => query.eq('status', 'confirmed')),
    countRows('bookings', query => query.eq('status', 'confirmed').gte('created_at', from).lt('created_at', to)),
    countRows('bookings', query => query.eq('status', 'cancelled').gte('created_at', from).lt('created_at', to)),
    countRows('tournaments'),
    countRows('tournaments', query => query.eq('status', 'live')),
    countRows('tournaments', query => query.eq('status', 'upcoming')),
    countRows('tournaments', query => query.eq('status', 'completed')),
    countRows('registrations', query => query.eq('status', 'approved')),
    countRows('results'),
    countRows('topup_requests', query => query.eq('status', 'pending')),
    countRows('withdrawal_requests', query => query.eq('status', 'pending')),
    countRows('security_events', query => query.eq('resolved', false)),
    countRows('security_events', query => query.eq('event_type', 'admin_login_failed').gte('created_at', from).lt('created_at', to)),
    safeFetchAll('bookings', 'entry_fee,status,created_at', query => query.eq('status', 'confirmed')),
    safeFetchAll('topup_requests', 'amount,status,created_at,reviewed_at', query => query.eq('status', 'approved').gte('reviewed_at', from).lt('reviewed_at', to)),
    safeFetchAll('withdrawal_requests', 'amount,status,created_at,reviewed_at', query => query.eq('status', 'approved').gte('reviewed_at', from).lt('reviewed_at', to)),
    safeFetchAll('topup_requests', 'amount,status', query => query.eq('status', 'pending')),
    safeFetchAll('withdrawal_requests', 'amount,status', query => query.eq('status', 'pending')),
    safeFetchAll('wallet_transactions', 'type,direction,amount,created_at', query => query.gte('created_at', from).lt('created_at', to)),
    safeFetchAll('site_events', 'session_id,event_type,created_at', query => query.eq('event_type', 'page_view').gte('created_at', from).lt('created_at', to)),
    safeFetchAll('users', 'wallet_balance', null),
    safeFetchAll('security_events', 'id', query => query.limit(1)),
    safeFetchAll('site_events', 'session_id,created_at', query => query.eq('event_type', 'page_view').gte('created_at', new Date(Date.now() - 5 * 60 * 1000).toISOString()))
  ]);

  const confirmedRows = confirmedBookings.rows || [];
  const bookingRevenue = confirmedRows.reduce((sum, row) => sum + toNumber(row.entry_fee), 0);
  const revenueInRange = confirmedRows
    .filter(row => row.created_at >= from && row.created_at < to)
    .reduce((sum, row) => sum + toNumber(row.entry_fee), 0);
  const topupRows = topups.rows || [];
  const withdrawalRows = withdrawals.rows || [];
  const walletRows = walletTx.rows || [];
  const pageviewRows = pageviews.rows || [];
  const pendingTopupAmount = (pendingTopupRows.rows || []).reduce((sum, row) => sum + toNumber(row.amount), 0);
  const pendingWithdrawalAmount = (pendingWithdrawalRows.rows || []).reduce((sum, row) => sum + toNumber(row.amount), 0);
  const walletFloat = (userBalances.rows || []).reduce((sum, row) => sum + toNumber(row.wallet_balance), 0);

  return {
    ...normalizeSummary({
      users_total: usersTotal,
      users_new: usersNew,
      active_users: activeUsers,
      bookings_total: bookingsTotal,
      bookings_in_range: bookingsInRange,
      bookings_cancelled: bookingsCancelled,
      booking_revenue: bookingRevenue,
      revenue_in_range: revenueInRange,
      topups_approved_in_range: topupRows.reduce((sum, row) => sum + toNumber(row.amount), 0),
      topups_pending_count: pendingTopups,
      topups_pending_amount: pendingTopupAmount,
      withdrawals_approved_in_range: withdrawalRows.reduce((sum, row) => sum + toNumber(row.amount), 0),
      withdrawals_pending_count: pendingWithdrawals,
      withdrawals_pending_amount: pendingWithdrawalAmount,
      wallet_float: walletFloat,
      wallet_volume_in_range: walletRows.reduce((sum, row) => sum + toNumber(row.amount), 0),
      refunds_in_range: walletRows
        .filter(row => row.type === 'refund' && row.direction === 'credit')
        .reduce((sum, row) => sum + toNumber(row.amount), 0),
      admin_credits_in_range: walletRows
        .filter(row => row.type === 'admin_credit' && row.direction === 'credit')
        .reduce((sum, row) => sum + toNumber(row.amount), 0),
      admin_debits_in_range: walletRows
        .filter(row => row.type === 'admin_credit' && row.direction === 'debit')
        .reduce((sum, row) => sum + toNumber(row.amount), 0),
      pageviews_in_range: pageviewRows.length,
      visitors_in_range: new Set(pageviewRows.map(row => row.session_id).filter(Boolean)).size,
      active_now: new Set((activeSessions.rows || []).map(row => row.session_id).filter(Boolean)).size,
      tournaments_total: tournamentsTotal,
      tournaments_live: tournamentsLive,
      tournaments_upcoming: tournamentsUpcoming,
      tournaments_completed: tournamentsCompleted,
      registrations_legacy: registrationsLegacy,
      results_count: resultsCount,
      security_failed_logins: failedLogins,
      security_unresolved: unresolvedSecurity
    }),
    traffic_ready: !pageviews.missing,
    security_ready: !securityProbe.missing
  };
}

async function getSummary(range) {
  try {
    const { data, error } = await supabase.rpc('analytics_summary', {
      p_from: range.from,
      p_to: range.to
    });
    if (!error && data) {
      return { ...normalizeSummary(data), source: 'database', traffic_ready: true, security_ready: true };
    }
    if (error && !isMissingTableError(error)) {
      console.error('Analytics summary RPC:', error.message);
    }
  } catch (err) {
    if (!isMissingTableError(err)) console.error('Analytics summary RPC exception:', err.message);
  }

  const summary = await fallbackSummary(range);
  return {
    ...summary,
    source: 'fallback'
  };
}

function buildBuckets(range) {
  const start = new Date(range.from);
  const end = new Date(range.to);
  const buckets = [];
  const stepMs = range.bucket === 'hour' ? 60 * 60 * 1000 : DAY_MS;
  const cursor = new Date(start);
  if (range.bucket === 'hour') cursor.setUTCMinutes(0, 0, 0);
  else cursor.setUTCHours(0, 0, 0, 0);

  let guard = 0;
  while (cursor.getTime() < end.getTime() && guard < 500) {
    buckets.push(new Date(cursor));
    cursor.setTime(cursor.getTime() + stepMs);
    guard += 1;
  }
  return buckets;
}

function bucketKey(date, bucket) {
  const iso = new Date(date).toISOString();
  return bucket === 'hour' ? iso.slice(0, 13) + ':00:00.000Z' : iso.slice(0, 10);
}

function emptySeriesRow(bucketDate, bucket) {
  return {
    bucket: bucketDate.toISOString(),
    label: bucket === 'hour'
      ? bucketDate.toISOString().slice(11, 16)
      : bucketDate.toISOString().slice(5, 10),
    users: 0,
    bookings: 0,
    revenue: 0,
    topups: 0,
    withdrawals: 0,
    pageviews: 0,
    visitors: 0
  };
}

async function fallbackSeries(range) {
  const [users, bookings, topups, withdrawals, events] = await Promise.all([
    safeFetchAll('users', 'created_at', query => query.gte('created_at', range.from).lt('created_at', range.to)),
    safeFetchAll('bookings', 'entry_fee,status,created_at', query => query.eq('status', 'confirmed').gte('created_at', range.from).lt('created_at', range.to)),
    safeFetchAll('topup_requests', 'amount,status,reviewed_at', query => query.eq('status', 'approved').gte('reviewed_at', range.from).lt('reviewed_at', range.to)),
    safeFetchAll('withdrawal_requests', 'amount,status,reviewed_at', query => query.eq('status', 'approved').gte('reviewed_at', range.from).lt('reviewed_at', range.to)),
    safeFetchAll('site_events', 'session_id,event_type,created_at', query => query.eq('event_type', 'page_view').gte('created_at', range.from).lt('created_at', range.to))
  ]);

  const buckets = buildBuckets(range);
  const byKey = new Map(buckets.map(date => [bucketKey(date, range.bucket), emptySeriesRow(date, range.bucket)]));

  const ensure = date => {
    const key = bucketKey(date, range.bucket);
    if (!byKey.has(key)) return null;
    return byKey.get(key);
  };

  (users.rows || []).forEach(row => {
    const item = ensure(row.created_at);
    if (item) item.users += 1;
  });
  (bookings.rows || []).forEach(row => {
    const item = ensure(row.created_at);
    if (item) {
      item.bookings += 1;
      item.revenue += toNumber(row.entry_fee);
    }
  });
  (topups.rows || []).forEach(row => {
    const item = ensure(row.reviewed_at);
    if (item) item.topups += toNumber(row.amount);
  });
  (withdrawals.rows || []).forEach(row => {
    const item = ensure(row.reviewed_at);
    if (item) item.withdrawals += toNumber(row.amount);
  });
  (events.rows || []).forEach(row => {
    const item = ensure(row.created_at);
    if (item) item.pageviews += 1;
  });

  // Unique visitors per bucket.
  const visitorsByKey = new Map();
  (events.rows || []).forEach(row => {
    if (!row.session_id) return;
    const key = bucketKey(row.created_at, range.bucket);
    if (!visitorsByKey.has(key)) visitorsByKey.set(key, new Set());
    visitorsByKey.get(key).add(row.session_id);
  });
  for (const [key, set] of visitorsByKey) {
    const item = byKey.get(key);
    if (item) item.visitors = set.size;
  }

  return {
    series: [...byKey.values()],
    source: 'fallback',
    traffic_ready: !events.missing,
    truncated: Boolean(users.truncated || bookings.truncated || events.truncated)
  };
}

async function getSeries(range) {
  try {
    const { data, error } = await supabase.rpc('analytics_series', {
      p_from: range.from,
      p_to: range.to,
      p_bucket: range.bucket
    });
    if (!error && Array.isArray(data)) {
      return {
        range,
        series: data.map(row => ({
          bucket: row.bucket,
          label: range.bucket === 'hour'
            ? new Date(row.bucket).toISOString().slice(11, 16)
            : new Date(row.bucket).toISOString().slice(5, 10),
          users: toNumber(row.users),
          bookings: toNumber(row.bookings),
          revenue: toNumber(row.revenue),
          topups: toNumber(row.topups),
          withdrawals: toNumber(row.withdrawals),
          pageviews: toNumber(row.pageviews),
          visitors: toNumber(row.visitors)
        })),
        source: 'database',
        traffic_ready: true
      };
    }
    if (error && !isMissingTableError(error)) console.error('Analytics series RPC:', error.message);
  } catch (err) {
    if (!isMissingTableError(err)) console.error('Analytics series RPC exception:', err.message);
  }

  const fallback = await fallbackSeries(range);
  return { range, ...fallback };
}

function deviceFromUserAgent(userAgent) {
  const ua = String(userAgent || '').toLowerCase();
  if (!ua) return 'Unknown';
  if (/ipad|tablet|playbook|silk/.test(ua)) return 'Tablet';
  if (/mobile|android|iphone|ipod|windows phone/.test(ua)) return 'Mobile';
  if (/bot|crawler|spider|headless/.test(ua)) return 'Bot';
  return 'Desktop';
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

async function getTraffic(range) {
  const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const events = await safeFetchAll(
    'site_events',
    'path,session_id,referrer,user_agent,created_at,event_type',
    query => query.eq('event_type', 'page_view').gte('created_at', range.from).lt('created_at', range.to),
    20000
  );

  const active = await safeFetchAll(
    'site_events',
    'session_id,created_at',
    query => query.eq('event_type', 'page_view').gte('created_at', since),
    5000
  );

  const rows = events.rows || [];
  const activeRows = active.rows || [];
  const memory = getMemoryTraffic();
  const missing = Boolean(events.missing);
  const sourceRows = missing ? memory : rows;
  const activeNow = new Set(
    (missing ? memory.filter(row => row.created_at >= since) : activeRows)
      .map(row => row.session_id)
      .filter(Boolean)
  ).size;

  return {
    ready: !missing,
    source: missing ? 'memory' : 'database',
    active_now: activeNow,
    pageviews: sourceRows.length,
    visitors: new Set(sourceRows.map(row => row.session_id).filter(Boolean)).size,
    top_pages: countBy(sourceRows, row => row.path || '/').slice(0, 8),
    top_referrers: countBy(sourceRows, row => {
      if (!row.referrer) return 'Direct';
      try {
        return new URL(row.referrer).hostname.replace(/^www\./, '');
      } catch {
        return 'Direct';
      }
    }).slice(0, 6),
    devices: countBy(sourceRows, row => deviceFromUserAgent(row.user_agent)),
    recent: sourceRows
      .slice()
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, 12)
      .map(row => ({
        path: row.path || '/',
        created_at: row.created_at,
        session_id: row.session_id ? String(row.session_id).slice(0, 8) : null
      })),
    truncated: Boolean(events.truncated)
  };
}

async function getWalletMix(range) {
  const result = await safeFetchAll(
    'wallet_transactions',
    'type,direction,amount,created_at',
    query => query.gte('created_at', range.from).lt('created_at', range.to)
  );
  const rows = result.rows || [];
  const map = new Map();
  for (const row of rows) {
    const key = `${row.type}:${row.direction}`;
    const entry = map.get(key) || { type: row.type, direction: row.direction, count: 0, amount: 0 };
    entry.count += 1;
    entry.amount += toNumber(row.amount);
    map.set(key, entry);
  }
  return {
    ready: !result.missing,
    rows: [...map.values()].sort((a, b) => b.amount - a.amount)
  };
}

async function getTournamentPerformance(range) {
  const [tournaments, bookings, legacy, results] = await Promise.all([
    safeFetchAll('tournaments', '*', null),
    safeFetchAll('bookings', 'tournament_id,entry_fee,status,created_at,team_name', query => query.eq('status', 'confirmed')),
    safeFetchAll('registrations', 'tournament_id,status,created_at', query => query.eq('status', 'approved')),
    safeFetchAll('results', 'tournament_id,team_name,points,kills,position', null)
  ]);

  const tournamentsRows = tournaments.rows || [];
  const bookingRows = bookings.rows || [];
  const legacyRows = legacy.rows || [];
  const resultRows = results.rows || [];

  const byTournament = new Map();
  for (const tournament of tournamentsRows) {
    byTournament.set(tournament.id, {
      id: tournament.id,
      name: tournament.name,
      status: tournament.status,
      date: tournament.date,
      entry_fee: toNumber(tournament.entry_fee),
      prize_pool: toNumber(tournament.prize_pool),
      max_teams: toNumber(tournament.max_teams),
      booked: 0,
      legacy: 0,
      revenue: 0,
      results: 0,
      winner: null
    });
  }

  for (const row of bookingRows) {
    const item = byTournament.get(row.tournament_id);
    if (!item) continue;
    item.booked += 1;
    item.revenue += toNumber(row.entry_fee);
  }
  for (const row of legacyRows) {
    const item = byTournament.get(row.tournament_id);
    if (!item) continue;
    item.legacy += 1;
  }

  const resultsByTournament = new Map();
  for (const row of resultRows) {
    if (!resultsByTournament.has(row.tournament_id)) resultsByTournament.set(row.tournament_id, []);
    resultsByTournament.get(row.tournament_id).push(row);
  }
  for (const [tournamentId, rows] of resultsByTournament) {
    const item = byTournament.get(tournamentId);
    if (!item) continue;
    rows.sort((a, b) => toNumber(b.points) - toNumber(a.points) || toNumber(b.kills) - toNumber(a.kills));
    item.results = rows.length;
    item.winner = rows[0]?.team_name || null;
  }

  const fromDate = range.from.slice(0, 10);
  const toDate = range.to.slice(0, 10);
  const rows = [...byTournament.values()]
    .map(item => {
      const slots = item.booked + item.legacy;
      return {
        ...item,
        slots,
        fill_rate: item.max_teams > 0 ? Math.round((slots / item.max_teams) * 1000) / 10 : 0,
        remaining: Math.max(0, item.max_teams - slots)
      };
    })
    .filter(item => {
      if (item.status === 'live' || item.status === 'upcoming') return true;
      const date = item.date || '';
      return (!date || (date >= fromDate && date <= toDate)) || item.results > 0;
    })
    .sort((a, b) => b.revenue - a.revenue || b.slots - a.slots);

  return {
    ready: !tournaments.missing && !bookings.missing,
    rows: rows.slice(0, 20),
    totals: {
      tournaments: rows.length,
      slots: rows.reduce((sum, item) => sum + item.slots, 0),
      revenue: rows.reduce((sum, item) => sum + item.revenue, 0),
      prize_pool: rows.reduce((sum, item) => sum + item.prize_pool, 0)
    }
  };
}

function compareSummary(current, previous) {
  const keys = [
    'visitors_in_range', 'pageviews_in_range', 'users_new', 'bookings_in_range',
    'revenue_in_range', 'topups_approved_in_range', 'withdrawals_approved_in_range',
    'wallet_volume_in_range'
  ];
  const comparison = {};
  for (const key of keys) {
    const now = toNumber(current[key]);
    const before = toNumber(previous[key]);
    const delta = now - before;
    comparison[key] = {
      current: now,
      previous: before,
      delta,
      percent: before > 0 ? Math.round((delta / before) * 1000) / 10 : null
    };
  }
  return comparison;
}

async function getOverview(range) {
  const [current, previous, tournaments, walletMix, traffic] = await Promise.all([
    getSummary(range),
    getSummary({ ...range, from: range.previousFrom, to: range.previousTo }),
    getTournamentPerformance(range),
    getWalletMix(range),
    getTraffic(range)
  ]);

  return {
    range,
    summary: current,
    previous,
    comparison: compareSummary(current, previous),
    tournaments,
    wallet_mix: walletMix,
    traffic
  };
}

module.exports = {
  parseRange,
  getSummary,
  getSeries,
  getTraffic,
  getWalletMix,
  getTournamentPerformance,
  getOverview,
  recordTrafficMemory,
  getMemoryTraffic,
  toNumber
};
