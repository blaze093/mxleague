// ============================================
// REE CLASS — Google ID token verification
// ============================================
// Verifies the credential returned by Google Identity Services locally
// against Google's published JWKS. No extra npm dependency required.
const crypto = require('crypto');

const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

let jwksCache = { keys: [], expiresAt: 0 };

function getGoogleClientId() {
  const id = (process.env.GOOGLE_CLIENT_ID || '').trim();
  return id || null;
}

function decodeBase64Url(value) {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function parseJwtPart(part) {
  try {
    return JSON.parse(decodeBase64Url(part).toString('utf8'));
  } catch {
    return null;
  }
}

async function loadGoogleKeys(force = false) {
  const now = Date.now();
  if (!force && jwksCache.keys.length > 0 && now < jwksCache.expiresAt) {
    return jwksCache.keys;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    const response = await fetch(GOOGLE_CERTS_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) throw new Error(`Google JWKS request failed (${response.status})`);
    const body = await response.json();
    if (!Array.isArray(body.keys) || body.keys.length === 0) {
      throw new Error('Google JWKS response contained no keys');
    }
    const maxAge = Math.max(300, Number(body.max_age) || 3600);
    jwksCache = { keys: body.keys, expiresAt: now + maxAge * 1000 };
    return jwksCache.keys;
  } catch (err) {
    // Keep serving cached keys if Google is temporarily unreachable.
    if (jwksCache.keys.length > 0) return jwksCache.keys;
    throw new Error('Google Sign-In is temporarily unavailable. Please try again.');
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyGoogleIdToken(credential) {
  const clientId = getGoogleClientId();
  if (!clientId) {
    const err = new Error('Google Sign-In is not configured. Add GOOGLE_CLIENT_ID to backend/.env.');
    err.statusCode = 503;
    throw err;
  }
  if (!credential || typeof credential !== 'string') {
    const err = new Error('Missing Google credential');
    err.statusCode = 400;
    throw err;
  }

  const parts = credential.split('.');
  if (parts.length !== 3) {
    const err = new Error('Invalid Google credential');
    err.statusCode = 400;
    throw err;
  }

  const header = parseJwtPart(parts[0]);
  const payload = parseJwtPart(parts[1]);
  if (!header || !payload || header.alg !== 'RS256' || !header.kid) {
    const err = new Error('Invalid Google credential');
    err.statusCode = 400;
    throw err;
  }

  let keys = await loadGoogleKeys();
  let jwk = keys.find(key => key.kid === header.kid);

  // Google rotates keys occasionally. Refresh once if the kid is unknown.
  if (!jwk) {
    keys = await loadGoogleKeys(true);
    jwk = keys.find(key => key.kid === header.kid);
  }
  if (!jwk || jwk.kty !== 'RSA') {
    const err = new Error('Google signing key not found');
    err.statusCode = 401;
    throw err;
  }

  let publicKey;
  try {
    publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    const err = new Error('Invalid Google signing key');
    err.statusCode = 401;
    throw err;
  }

  const signedData = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = decodeBase64Url(parts[2]);
  let valid = false;
  try {
    valid = crypto.verify('RSA-SHA256', signedData, publicKey, signature);
  } catch {
    valid = false;
  }
  if (!valid) {
    const err = new Error('Google credential signature is invalid');
    err.statusCode = 401;
    throw err;
  }

  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp <= now + 5) {
    const err = new Error('Google credential has expired');
    err.statusCode = 401;
    throw err;
  }
  if (!payload.iat || payload.iat > now + 120) {
    const err = new Error('Google credential is not valid yet');
    err.statusCode = 401;
    throw err;
  }
  if (!GOOGLE_ISSUERS.has(payload.iss)) {
    const err = new Error('Google credential issuer is invalid');
    err.statusCode = 401;
    throw err;
  }

  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(clientId)) {
    const err = new Error('Google credential was issued for a different application');
    err.statusCode = 401;
    throw err;
  }

  const emailVerified = payload.email_verified === true || payload.email_verified === 'true';
  if (!payload.sub || !payload.email || !emailVerified) {
    const err = new Error('Google account email is not verified');
    err.statusCode = 401;
    throw err;
  }

  return {
    sub: String(payload.sub),
    email: String(payload.email).toLowerCase().trim(),
    emailVerified,
    name: String(payload.name || payload.email.split('@')[0]).trim().slice(0, 80),
    picture: payload.picture ? String(payload.picture) : null
  };
}

module.exports = { getGoogleClientId, verifyGoogleIdToken };
