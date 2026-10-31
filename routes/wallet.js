// ============================================
// REE CLASS — User wallet routes
// ============================================
const crypto = require('crypto');
const supabase = require('../lib/supabase');
const { requireUser } = require('../lib/auth');
const {
  getWalletSummary,
  parseAmount,
  rpcErrorResponse,
  isCloudinaryUrl,
  cleanText,
  idempotencyKey,
  isWalletSchemaMissing,
  walletUnavailable
} = require('../lib/wallet');

const UPI_RE = /^[a-zA-Z0-9._-]{2,80}@[a-zA-Z]{2,40}$/;

function topupFields(row) {
  return {
    id: row.id,
    amount: Number(row.amount),
    screenshot_url: row.screenshot_url,
    screenshot_public_id: row.screenshot_public_id,
    upi_reference: row.upi_reference,
    status: row.status,
    admin_note: row.admin_note,
    reviewed_at: row.reviewed_at,
    created_at: row.created_at
  };
}

function withdrawalFields(row) {
  return {
    id: row.id,
    amount: Number(row.amount),
    upi_id: row.upi_id,
    status: row.status,
    admin_note: row.admin_note,
    upi_reference: row.upi_reference,
    reviewed_at: row.reviewed_at,
    created_at: row.created_at
  };
}

async function walletRoutes(fastify) {
  fastify.addHook('onSend', async (request, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // GET /api/wallet — balance + reserved + lifetime totals
  fastify.get('/', { preHandler: [requireUser] }, async (request, reply) => {
    try {
      return await getWalletSummary(request.user.id);
    } catch (err) {
      if (isWalletSchemaMissing(err)) return walletUnavailable(reply);
      console.error('Wallet summary error:', err);
      return reply.status(500).send({ error: 'Failed to load wallet' });
    }
  });

  // GET /api/wallet/transactions
  fastify.get('/transactions', { preHandler: [requireUser] }, async (request, reply) => {
    try {
      const limit = Math.min(200, Math.max(1, parseInt(request.query.limit, 10) || 50));
      const offset = Math.max(0, parseInt(request.query.offset, 10) || 0);
      const type = String(request.query.type || '').trim();
      const allowedTypes = ['topup', 'booking', 'withdrawal', 'admin_credit', 'refund'];

      let query = supabase
        .from('wallet_transactions')
        .select('id, type, direction, amount, balance_before, balance_after, description, reference_type, reference_id, created_at')
        .eq('user_id', request.user.id);

      if (type && allowedTypes.includes(type)) query = query.eq('type', type);
      query = query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

      const { data, error } = await query;
      if (error) {
        if (isWalletSchemaMissing(error)) return walletUnavailable(reply);
        console.error('Wallet transactions error:', error);
        return reply.status(500).send({ error: 'Failed to load transactions' });
      }
      return data || [];
    } catch (err) {
      return reply.status(500).send({ error: 'Failed to load transactions' });
    }
  });

  // GET /api/wallet/topups
  fastify.get('/topups', { preHandler: [requireUser] }, async (request, reply) => {
    try {
      const { data, error } = await supabase
        .from('topup_requests')
        .select('id, amount, screenshot_url, screenshot_public_id, upi_reference, status, admin_note, reviewed_at, created_at')
        .eq('user_id', request.user.id)
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) {
        if (isWalletSchemaMissing(error)) return walletUnavailable(reply);
        console.error('Topup list error:', error);
        return reply.status(500).send({ error: 'Failed to load top-up requests' });
      }
      return (data || []).map(topupFields);
    } catch (err) {
      return reply.status(500).send({ error: 'Failed to load top-up requests' });
    }
  });

  // POST /api/wallet/topups — pending until admin approves
  fastify.post('/topups', {
    preHandler: [requireUser],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } }
  }, async (request, reply) => {
    try {
      const body = request.body || {};
      const amount = parseAmount(body.amount, { min: 1, max: 1000000 });
      if (!amount) {
        return reply.status(400).send({ error: 'Enter a valid amount between ₹1 and ₹10,00,000' });
      }
      if (!isCloudinaryUrl(body.screenshot_url)) {
        return reply.status(400).send({ error: 'Upload a valid payment screenshot' });
      }

      const key = idempotencyKey(body.idempotency_key) ||
        `topup-${request.user.id.slice(0, 8)}-${crypto.randomUUID()}`;

      const { data: existing } = await supabase
        .from('topup_requests')
        .select('*')
        .eq('idempotency_key', key)
        .maybeSingle();

      if (existing) return { request: topupFields(existing), duplicate: true };

      const { count } = await supabase
        .from('topup_requests')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', request.user.id)
        .eq('status', 'pending');

      if ((count || 0) >= 10) {
        return reply.status(429).send({ error: 'You already have 10 pending top-up requests. Wait for admin review.' });
      }

      const { data, error } = await supabase
        .from('topup_requests')
        .insert({
          user_id: request.user.id,
          amount,
          screenshot_url: body.screenshot_url,
          screenshot_public_id: cleanText(body.screenshot_public_id, 200) || null,
          upi_reference: cleanText(body.upi_reference, 120) || null,
          status: 'pending',
          idempotency_key: key
        })
        .select('*')
        .single();

      if (error) {
        if (isWalletSchemaMissing(error)) return walletUnavailable(reply);
        if (error.code === '23505') {
          const { data: raced } = await supabase
            .from('topup_requests')
            .select('*')
            .eq('idempotency_key', key)
            .single();
          if (raced) return { request: topupFields(raced), duplicate: true };
        }
        console.error('Topup insert error:', error);
        return reply.status(500).send({ error: 'Failed to submit top-up request' });
      }

      return reply.status(201).send({
        request: topupFields(data),
        message: 'Top-up submitted. Your wallet will be credited after admin verification.'
      });
    } catch (err) {
      console.error('Topup submit exception:', err);
      return reply.status(500).send({ error: 'Failed to submit top-up request' });
    }
  });

  // GET /api/wallet/withdrawals
  fastify.get('/withdrawals', { preHandler: [requireUser] }, async (request, reply) => {
    try {
      const { data, error } = await supabase
        .from('withdrawal_requests')
        .select('id, amount, upi_id, status, admin_note, upi_reference, reviewed_at, created_at')
        .eq('user_id', request.user.id)
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) {
        if (isWalletSchemaMissing(error)) return walletUnavailable(reply);
        console.error('Withdrawal list error:', error);
        return reply.status(500).send({ error: 'Failed to load withdrawal requests' });
      }
      return (data || []).map(withdrawalFields);
    } catch (err) {
      return reply.status(500).send({ error: 'Failed to load withdrawal requests' });
    }
  });

  // POST /api/wallet/withdrawals — reserves funds, deducts on approval
  fastify.post('/withdrawals', {
    preHandler: [requireUser],
    config: { rateLimit: { max: 8, timeWindow: '1 minute' } }
  }, async (request, reply) => {
    try {
      const body = request.body || {};
      const amount = parseAmount(body.amount, { min: 1, max: 1000000 });
      if (!amount) {
        return reply.status(400).send({ error: 'Enter a valid withdrawal amount between ₹1 and ₹10,00,000' });
      }
      const upiId = cleanText(body.upi_id, 100);
      if (!UPI_RE.test(upiId)) {
        return reply.status(400).send({ error: 'Enter a valid UPI ID (for example name@okaxis)' });
      }
      const key = idempotencyKey(body.idempotency_key) ||
        `withdraw-${request.user.id.slice(0, 8)}-${crypto.randomUUID()}`;

      const { data, error } = await supabase.rpc('wallet_withdraw_request', {
        p_user_id: request.user.id,
        p_amount: amount,
        p_upi_id: upiId,
        p_idempotency_key: key
      });

      if (error) return rpcErrorResponse(reply, error, 'Failed to submit withdrawal request');

      return reply.status(201).send({
        ...data,
        message: 'Withdrawal requested. The amount stays in your wallet until the admin approves the transfer.'
      });
    } catch (err) {
      console.error('Withdrawal submit exception:', err);
      return reply.status(500).send({ error: 'Failed to submit withdrawal request' });
    }
  });
}

module.exports = walletRoutes;
