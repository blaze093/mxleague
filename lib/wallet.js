// ============================================
// REE CLASS — Wallet helpers
// ============================================
const supabase = require('./supabase');

const WALLET_SETUP_ERROR =
  'Wallet system is not initialized yet. Run database/wallet-migration.sql in Supabase SQL Editor.';

function isWalletSchemaMissing(error) {
  if (!error) return false;
  if (['42P01', 'PGRST202', 'PGRST205', '42883'].includes(error.code)) return true;
  const message = String(error.message || '').toLowerCase();
  return message.includes('schema cache') ||
    message.includes('does not exist') ||
    message.includes('could not find the table') ||
    message.includes('could not find the function');
}

function walletUnavailable(reply) {
  return reply.status(503).send({ error: WALLET_SETUP_ERROR });
}

async function getWalletSummary(userId) {
  const { data, error } = await supabase.rpc('wallet_summary', { p_user_id: userId });
  if (error) throw error;
  return data || {};
}

function parseAmount(value, { min = 1, max = 1000000 } = {}) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  const rounded = Math.round(amount * 100) / 100;
  if (rounded < min || rounded > max) return null;
  return rounded;
}

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function rpcErrorResponse(reply, error, fallback = 'Wallet request failed') {
  if (isWalletSchemaMissing(error)) {
    return reply.status(503).send({ error: WALLET_SETUP_ERROR });
  }

  const message = String(error && error.message ? error.message : '').replace(/^.*?:\s*/, '').trim();
  const lower = message.toLowerCase();

  let status = 400;
  if (lower.includes('not found')) status = 404;
  else if (lower.includes('already') || lower.includes('full') || lower.includes('insufficient')) status = 409;
  else if (lower.includes('suspended')) status = 403;
  else if (!message) status = 500;

  return reply.status(status).send({
    error: message || fallback
  });
}

function isCloudinaryUrl(url) {
  return typeof url === 'string' && /^https:\/\/res\.cloudinary\.com\//.test(url);
}

function cleanText(value, maxLength = 200) {
  return String(value == null ? '' : value)
    .replace(/<[^>]*>/g, '')
    .trim()
    .slice(0, maxLength);
}

function idempotencyKey(value) {
  const key = String(value || '').trim();
  if (!key) return null;
  if (key.length < 8 || key.length > 120) return null;
  if (!/^[A-Za-z0-9:_-]+$/.test(key)) return null;
  return key;
}

module.exports = {
  WALLET_SETUP_ERROR,
  isWalletSchemaMissing,
  walletUnavailable,
  getWalletSummary,
  parseAmount,
  money,
  rpcErrorResponse,
  isCloudinaryUrl,
  cleanText,
  idempotencyKey
};
