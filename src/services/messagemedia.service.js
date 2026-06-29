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

function determineStatus(credentialStatus, sourceNumberConfigured, accountType, creditBalance, warningCredits, criticalCredits) {
  if (credentialStatus === 'Invalid') {
    return { status: 'Blocked', message: 'MessageMedia API credentials are invalid. Please verify API key and secret.' };
  }
  if (!sourceNumberConfigured) {
    return { status: 'Blocked', message: 'MessageMedia source number is missing.' };
  }
  if (accountType === 'Prepaid' && typeof creditBalance === 'number') {
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
  const endpoint = creditEndpoint || 'https://api.messagemedia.com/v1/messages/credits';

  let credentialStatus = 'Unknown';
  let accountType      = 'Postpaid / Unknown';
  let creditBalance    = null;
  let credentialError  = null;

  try {
    const { statusCode, body } = await httpsGetBasic(endpoint, apiKey, apiSecret);

    if (statusCode === 401 || statusCode === 403) {
      credentialStatus = 'Invalid';
      credentialError  = `API returned HTTP ${statusCode} — credentials rejected.`;
      return { credentialStatus, accountType, creditBalance, credentialError };
    }

    // Credentials are accepted
    credentialStatus = 'Valid';

    if (statusCode === 200) {
      let raw;
      try { raw = JSON.parse(body); } catch (_) { raw = null; }
      if (raw !== null) {
        // Try common credit-balance field names
        const balance =
          raw.creditBalance  ??
          raw.credit_balance ??
          raw.credits        ??
          raw.balance        ??
          null;

        if (typeof balance === 'number' || (typeof balance === 'string' && !isNaN(Number(balance)))) {
          creditBalance = Number(balance);
          accountType   = 'Prepaid';
        }
      }
    } else if (statusCode === 404) {
      // Endpoint exists but credit route not supported — postpaid or different plan
      accountType = 'Postpaid / Unknown';
    } else {
      // Any other 2xx/3xx/5xx — credentials may be valid but endpoint is unexpected
      accountType = 'Postpaid / Unknown';
    }
  } catch (e) {
    credentialError = e.message && e.message.length < 200 ? e.message : 'Network error contacting MessageMedia API.';
    console.warn('[MessageMedia] Credential check error:', credentialError);
  }

  return { credentialStatus, accountType, creditBalance, credentialError };
}

// ── Main export ───────────────────────────────────────────────────────────────

async function fetchMessageMediaStatus() {
  const apiKey         = process.env.MESSAGEMEDIA_API_KEY;
  const apiSecret      = process.env.MESSAGEMEDIA_API_SECRET;
  const sourceNumber   = process.env.MESSAGEMEDIA_SOURCE_NUMBER;
  const creditEndpoint = process.env.MESSAGEMEDIA_CREDIT_BALANCE_ENDPOINT || 'https://api.messagemedia.com/v1/messages/credits';
  const warningCredits = parseInt(process.env.MESSAGEMEDIA_WARNING_CREDITS  || '500', 10);
  const criticalCredits= parseInt(process.env.MESSAGEMEDIA_CRITICAL_CREDITS || '100', 10);

  // Missing credential checks — short-circuit immediately
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

  const { credentialStatus, accountType, creditBalance, credentialError } =
    await fetchCredentialAndCredit(apiKey, apiSecret, creditEndpoint);

  if (credentialStatus === 'Invalid') {
    const err = new Error('MessageMedia API credentials are invalid. Verify MESSAGEMEDIA_API_KEY and MESSAGEMEDIA_API_SECRET.');
    err.authError = true;
    throw err;
  }

  const { status, message } = determineStatus(
    credentialStatus, !!sourceNumber, accountType, creditBalance, warningCredits, criticalCredits
  );

  return {
    provider:            'Sinch MessageMedia',
    portal:              'https://hub.messagemedia.com/',
    sourceNumber,
    credentialStatus,
    credentialError:     credentialError || null,
    sourceNumberStatus:  'Configured',
    accountType,
    creditBalance,
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
