'use strict';

const https = require('node:https');
const http  = require('node:http');

// ── In-memory last-error cache (resets on redeploy — acceptable, no DB needed) ─
const _lastError = { code: null, message: null, time: null };

function recordSmsError(code, message) {
  _lastError.code    = code    || null;
  _lastError.message = message || null;
  _lastError.time    = new Date().toISOString();
  console.error(`[MessageMedia SMS Error] ${code}: ${message}`);
}

// ── HTTP helper — Basic Auth GET ──────────────────────────────────────────────

function httpsGetBasic(endpoint, apiKey, apiSecret) {
  return new Promise((resolve, reject) => {
    const url     = new URL(endpoint);
    const encoded = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
    const options = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      method:   'GET',
      headers: {
        'Authorization': `Basic ${encoded}`,
        'Accept':        'application/json',
      },
    };
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(options, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('Request timed out after 10s')); });
    req.end();
  });
}

// ── Postpaid / not-applicable defaults ───────────────────────────────────────

function postpaidDefaults(billingMessage) {
  return {
    billingType:        'Postpaid / Usage-Based',
    creditStatus:       'Not Applicable',
    creditBalance:      null,
    creditExpiryDate:   null,
    creditExpiryStatus: 'Not Applicable',
    nextPaymentDate:    null,
    nextPaymentStatus:  'Available in MessageMedia Hub',
    billingMessage,
  };
}

// ── Extract a credit balance from a parsed JSON body ─────────────────────────

function extractBalance(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw.data && typeof raw.data === 'object' ? { ...raw, ...raw.data } : raw;
  const val = src.creditBalance ?? src.credit_balance ?? src.credits ?? src.balance ?? null;
  if (val === null) return null;
  const n = Number(val);
  return Number.isNaN(n) ? null : n;
}

function extractField(raw, ...keys) {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw.data && typeof raw.data === 'object' ? { ...raw, ...raw.data } : raw;
  for (const k of keys) {
    if (src[k] != null) return String(src[k]);
  }
  return null;
}

// ── Status badge logic ────────────────────────────────────────────────────────

function determineStatus(credentialStatus, sourceNumberConfigured, billingType, creditBalance, creditStatus, warningCredits, criticalCredits) {
  if (credentialStatus === 'Invalid') {
    return { status: 'Blocked', message: 'MessageMedia API credentials are invalid. Please verify API key and secret.' };
  }
  if (!sourceNumberConfigured) {
    return { status: 'Blocked', message: 'MessageMedia source number is missing.' };
  }
  if (billingType === 'Prepaid' && creditStatus === 'Available' && typeof creditBalance === 'number') {
    if (creditBalance <= 0) {
      return { status: 'Blocked', message: 'MessageMedia prepaid SMS credits are exhausted. Please recharge.' };
    }
    if (creditBalance <= criticalCredits) {
      return { status: 'Critical', message: 'MessageMedia SMS credits are critically low. Please recharge immediately.' };
    }
    if (creditBalance <= warningCredits) {
      return { status: 'Warning', message: 'MessageMedia SMS credits are low. Please plan recharge.' };
    }
  }
  return { status: 'Normal', message: 'MessageMedia SMS service is normal.' };
}

// ── Credential + credit check ─────────────────────────────────────────────────

async function fetchCredentialAndCredit(apiKey, apiSecret, creditEndpoint) {
  let credentialStatus = 'Unknown';
  let credentialError  = null;

  try {
    const { statusCode, body } = await httpsGetBasic(creditEndpoint, apiKey, apiSecret);

    if (statusCode === 401 || statusCode === 403) {
      return {
        credentialStatus: 'Invalid',
        credentialError:  `API returned HTTP ${statusCode} — credentials rejected.`,
        ...postpaidDefaults('Credentials are invalid. Unable to retrieve billing information.'),
      };
    }

    credentialStatus = 'Valid';

    if (statusCode === 200) {
      let raw = null;
      try { raw = JSON.parse(body); } catch { /* body not JSON — treat as no-balance */ }

      const balance = extractBalance(raw);

      if (balance !== null) {
        // Confirmed prepaid account with a credit balance
        let billingMessage = `Prepaid credit balance: ${balance}.`;

        const expiry = extractField(raw, 'expiryDate', 'expiry_date', 'creditExpiry', 'credit_expiry');
        const creditExpiryDate   = expiry;
        const creditExpiryStatus = expiry ? 'Available' : 'Not Available';
        if (!expiry) billingMessage += ' Credit expiry is not available via SMS API.';

        const nextPay = extractField(raw, 'nextPaymentDate', 'next_payment_date', 'nextPayment', 'next_payment');
        const nextPaymentDate   = nextPay;
        const nextPaymentStatus = nextPay ? 'Available' : 'Not Available';
        if (!nextPay) billingMessage += ' Next payment is not available via SMS API.';

        return {
          credentialStatus,
          credentialError: null,
          billingType:     'Prepaid',
          creditStatus:    'Available',
          creditBalance:   balance,
          creditExpiryDate,
          creditExpiryStatus,
          nextPaymentDate,
          nextPaymentStatus,
          billingMessage,
        };
      }

      // 200 but no recognisable balance field — treat same as postpaid
      console.info('[MessageMedia] Credit endpoint returned 200 but no balance field — treating as postpaid/usage-based.');
      return {
        credentialStatus,
        credentialError: null,
        ...postpaidDefaults('Credit balance API is not applicable for this account type. Billing and payment details are managed in MessageMedia Hub.'),
      };
    }

    // 404 or any other non-auth status — credit endpoint not supported for this account
    console.info(`[MessageMedia] Credit endpoint returned HTTP ${statusCode} — treating as postpaid/usage-based account.`);
    return {
      credentialStatus,
      credentialError: null,
      ...postpaidDefaults('Credit balance API is not applicable for this account type. Billing and payment details are managed in MessageMedia Hub.'),
    };

  } catch (e) {
    credentialError = e.message && e.message.length < 200 ? e.message : 'Network error contacting MessageMedia API.';
    console.warn('[MessageMedia] Credential/credit check error:', credentialError);
    return {
      credentialStatus,
      credentialError,
      ...postpaidDefaults(`Could not reach MessageMedia API: ${credentialError}`),
    };
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

async function fetchMessageMediaStatus() {
  const apiKey         = process.env.MESSAGEMEDIA_API_KEY;
  const apiSecret      = process.env.MESSAGEMEDIA_API_SECRET;
  const sourceNumber   = process.env.MESSAGEMEDIA_SOURCE_NUMBER;
  const creditEndpoint = process.env.MESSAGEMEDIA_CREDIT_BALANCE_ENDPOINT || 'https://api.messagemedia.com/v1/messages/credits';
  const warningCredits = Number.parseInt(process.env.MESSAGEMEDIA_WARNING_CREDITS  || '500', 10);
  const criticalCredits= Number.parseInt(process.env.MESSAGEMEDIA_CRITICAL_CREDITS || '100', 10);

  if (!apiKey) {
    const err = new Error('MESSAGEMEDIA_API_KEY is not configured.');
    err.configError = true;
    throw err;
  }
  if (!apiSecret) {
    const err = new Error('MESSAGEMEDIA_API_SECRET is not configured.');
    err.configError = true;
    throw err;
  }
  if (!sourceNumber) {
    const err = new Error('MESSAGEMEDIA_SOURCE_NUMBER is not configured.');
    err.configError = true;
    throw err;
  }

  const result = await fetchCredentialAndCredit(apiKey, apiSecret, creditEndpoint);

  if (result.credentialStatus === 'Invalid') {
    const err = new Error('MessageMedia API credentials are invalid. Verify MESSAGEMEDIA_API_KEY and MESSAGEMEDIA_API_SECRET.');
    err.authError = true;
    throw err;
  }

  const { status, message } = determineStatus(
    result.credentialStatus, !!sourceNumber,
    result.billingType, result.creditBalance, result.creditStatus,
    warningCredits, criticalCredits
  );

  return {
    provider:            'Sinch MessageMedia',
    portal:              'https://hub.messagemedia.com/',
    sourceNumber,
    credentialStatus:    result.credentialStatus,
    credentialError:     result.credentialError || null,
    sourceNumberStatus:  'Configured',
    billingType:         result.billingType,
    creditStatus:        result.creditStatus,
    creditBalance:       result.creditBalance,
    creditExpiryDate:    result.creditExpiryDate,
    creditExpiryStatus:  result.creditExpiryStatus,
    nextPaymentDate:     result.nextPaymentDate,
    nextPaymentStatus:   result.nextPaymentStatus,
    billingMessage:      result.billingMessage,
    warningCredits,
    criticalCredits,
    lastCheckedTime:     new Date().toISOString(),
    lastErrorCode:       _lastError.code,
    lastErrorMessage:    _lastError.message,
    lastErrorTime:       _lastError.time,
    status,
    message,
  };
}

// ── SMS send pre-check ────────────────────────────────────────────────────────

function checkSmsAllowed(statusData) {
  if (statusData.status === 'Blocked') {
    return {
      allowed: false,
      reason: 'SMS sending is temporarily unavailable because MessageMedia credentials, source number, or credits have an issue. Please contact admin.',
    };
  }
  if (statusData.status === 'Critical') {
    console.warn('[MessageMedia] SMS allowed but credits are critically low. Recharge immediately.');
  }
  return { allowed: true, reason: null };
}

module.exports = { fetchMessageMediaStatus, checkSmsAllowed, recordSmsError };
