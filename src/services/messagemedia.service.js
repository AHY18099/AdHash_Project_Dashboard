'use strict';

const https = require('https');
const http  = require('http');

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

// ── Status badge logic ────────────────────────────────────────────────────────

function determineStatus(credentialStatus, sourceNumberConfigured, billingType, creditBalance, creditStatus, warningCredits, criticalCredits) {
  if (credentialStatus === 'Invalid') {
    return { status: 'Blocked', message: 'MessageMedia API credentials are invalid. Please verify API key and secret.' };
  }
  if (!sourceNumberConfigured) {
    return { status: 'Blocked', message: 'MessageMedia source number is missing.' };
  }
  // Only apply credit rules when we actually have a confirmed Prepaid balance
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
  // Postpaid / Unknown credit — credentials valid, source configured → Normal
  return { status: 'Normal', message: 'MessageMedia SMS service is normal.' };
}

// ── Credential + credit check ─────────────────────────────────────────────────

async function fetchCredentialAndCredit(apiKey, apiSecret, creditEndpoint) {
  let credentialStatus  = 'Unknown';
  let billingType       = 'Unknown';
  let creditStatus      = 'Not Available';
  let creditBalance     = null;
  let creditExpiryDate  = null;
  let creditExpiryStatus= 'Not Available';
  let nextPaymentDate   = null;
  let nextPaymentStatus = 'Not Available';
  let billingMessage    = 'Credit balance is not available for this account type or API endpoint.';
  let credentialError   = null;

  try {
    const { statusCode, body } = await httpsGetBasic(creditEndpoint, apiKey, apiSecret);

    if (statusCode === 401 || statusCode === 403) {
      credentialStatus = 'Invalid';
      credentialError  = `API returned HTTP ${statusCode} — credentials rejected.`;
      billingMessage   = 'Credentials are invalid. Unable to retrieve billing information.';
      return { credentialStatus, billingType, creditStatus, creditBalance, creditExpiryDate, creditExpiryStatus, nextPaymentDate, nextPaymentStatus, billingMessage, credentialError };
    }

    // Credentials confirmed valid
    credentialStatus = 'Valid';

    if (statusCode === 200) {
      let raw;
      try { raw = JSON.parse(body); } catch (_) { raw = null; }

      if (raw !== null) {
        // Probe common field names for credit balance
        const balance =
          raw.creditBalance  ??
          raw.credit_balance ??
          raw.credits        ??
          raw.balance        ??
          (raw.data ? (raw.data.creditBalance ?? raw.data.credit_balance ?? raw.data.credits ?? raw.data.balance ?? null) : null) ??
          null;

        if (typeof balance === 'number' || (typeof balance === 'string' && !isNaN(Number(balance)))) {
          creditBalance  = Number(balance);
          billingType    = 'Prepaid';
          creditStatus   = 'Available';
          billingMessage = `Prepaid credit balance: ${creditBalance}.`;

          // Probe optional expiry fields — never invent
          const expiry =
            raw.expiryDate    ??
            raw.expiry_date   ??
            raw.creditExpiry  ??
            raw.credit_expiry ??
            (raw.data ? (raw.data.expiryDate ?? raw.data.expiry_date ?? null) : null) ??
            null;
          if (expiry) {
            creditExpiryDate   = String(expiry);
            creditExpiryStatus = 'Available';
          } else {
            creditExpiryStatus = 'Not Available';
            billingMessage += ' Credit expiry is not available via SMS API.';
          }

          // Probe optional next-payment fields — never invent
          const nextPay =
            raw.nextPaymentDate   ??
            raw.next_payment_date ??
            raw.nextPayment       ??
            raw.next_payment      ??
            (raw.data ? (raw.data.nextPaymentDate ?? raw.data.next_payment_date ?? null) : null) ??
            null;
          if (nextPay) {
            nextPaymentDate   = String(nextPay);
            nextPaymentStatus = 'Available';
          } else {
            nextPaymentStatus = 'Not Available';
            billingMessage += ' Next payment is not available via SMS API.';
          }
        } else {
          // 200 but no recognisable balance field
          billingType    = 'Postpaid / Unknown';
          creditStatus   = 'Not Available';
          billingMessage = 'Credit balance not available. Account may be postpaid or endpoint may not be supported.';
          creditExpiryStatus = 'Not Applicable';
        }
      }
    } else {
      // 404, 5xx, or any non-200/non-401/non-403 — credentials may be valid, endpoint unsupported
      billingType    = 'Postpaid / Unknown';
      creditStatus   = 'Not Available';
      billingMessage = `Credit balance not available. Account may be postpaid or endpoint may not be supported. (HTTP ${statusCode})`;
      creditExpiryStatus = 'Not Applicable';
      nextPaymentStatus  = 'Not Available';
    }
  } catch (e) {
    credentialError = e.message && e.message.length < 200 ? e.message : 'Network error contacting MessageMedia API.';
    billingMessage  = `Could not reach MessageMedia API: ${credentialError}`;
    console.warn('[MessageMedia] Credential/credit check error:', credentialError);
  }

  return { credentialStatus, billingType, creditStatus, creditBalance, creditExpiryDate, creditExpiryStatus, nextPaymentDate, nextPaymentStatus, billingMessage, credentialError };
}

// ── Main export ───────────────────────────────────────────────────────────────

async function fetchMessageMediaStatus() {
  const apiKey         = process.env.MESSAGEMEDIA_API_KEY;
  const apiSecret      = process.env.MESSAGEMEDIA_API_SECRET;
  const sourceNumber   = process.env.MESSAGEMEDIA_SOURCE_NUMBER;
  const creditEndpoint = process.env.MESSAGEMEDIA_CREDIT_BALANCE_ENDPOINT || 'https://api.messagemedia.com/v1/messages/credits';
  const warningCredits = parseInt(process.env.MESSAGEMEDIA_WARNING_CREDITS  || '500', 10);
  const criticalCredits= parseInt(process.env.MESSAGEMEDIA_CRITICAL_CREDITS || '100', 10);

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

  const {
    credentialStatus, billingType, creditStatus, creditBalance,
    creditExpiryDate, creditExpiryStatus, nextPaymentDate, nextPaymentStatus,
    billingMessage, credentialError,
  } = await fetchCredentialAndCredit(apiKey, apiSecret, creditEndpoint);

  if (credentialStatus === 'Invalid') {
    const err = new Error('MessageMedia API credentials are invalid. Verify MESSAGEMEDIA_API_KEY and MESSAGEMEDIA_API_SECRET.');
    err.authError = true;
    throw err;
  }

  const { status, message } = determineStatus(
    credentialStatus, !!sourceNumber, billingType, creditBalance, creditStatus, warningCredits, criticalCredits
  );

  return {
    provider:            'Sinch MessageMedia',
    portal:              'https://hub.messagemedia.com/',
    sourceNumber,
    credentialStatus,
    credentialError:     credentialError || null,
    sourceNumberStatus:  'Configured',
    // Billing / credit fields
    billingType,
    creditStatus,
    creditBalance,
    creditExpiryDate,
    creditExpiryStatus,
    nextPaymentDate,
    nextPaymentStatus,
    billingMessage,
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
