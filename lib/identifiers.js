// ============================================
// REE CLASS — Shared identifier validation
// ============================================
// PostgreSQL accepts any canonical UUID shape, including seeded ids such as
// 11111111-1111-1111-1111-111111111111. Do not enforce RFC version/variant
// bits here: legacy rows would become unreachable through validated routes.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return UUID_RE.test(String(value == null ? '' : value));
}

module.exports = { UUID_RE, isUuid };
