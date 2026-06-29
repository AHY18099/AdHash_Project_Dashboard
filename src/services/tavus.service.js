'use strict';

// Tavus usage monitoring uses the official billing quotas endpoint.
// Configure TAVUS_ACCOUNT_USAGE_ENDPOINT and TAVUS_BILLING_AUTH_TOKEN in Railway.

const https = require('node:https');

// ── In-memory last-error cache (reset on redeploy — no DB needed) ────────────
const _lastError = { code: null, message: null, time: null };

function recordTavusError(code, message) {
  _lastError.code    = code    || null;
  _lastError.message = message || null;
  _lastError.time    = new Date().toISOString();
  console.error(`[Tavus Error] ${code}: ${message}`);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpsGet(endpoint, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const options = {
      hostname: url.hostname,
      port:     url.port || 443,
      path:     url.pathname + url.search,
      method:   'GET',
      headers:  { 'Accept': 'application/json', ...headers },
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(new Error('Request timed out after 12s')); });
    req.end();
  });
}

// ── Safe JSON parse ───────────────────────────────────────────────────────────

function tryParseJson(body) {
  try { return JSON.parse(body); } catch { return null; }
}

// ── Quota helpers ─────────────────────────────────────────────────────────────

const UNLIMITED_THRESHOLD = 99999999;

function isUnlimitedLimit(limit) {
  return Number(limit) >= UNLIMITED_THRESHOLD;
}

function formatLimit(limit) {
  if (limit === null || limit === undefined) return null;
  return isUnlimitedLimit(limit) ? 'Unlimited' : limit;
}

function calculateUsagePercentage(currentUsage, usageLimit) {
  if (!usageLimit || isUnlimitedLimit(usageLimit)) return null;
  return Number(((currentUsage / usageLimit) * 100).toFixed(2));
}

function normaliseQuotaItem(raw, label) {
  if (!raw || typeof raw !== 'object') return null;
  const current  = typeof raw.currentUsage  === 'number' ? raw.currentUsage  : 0;
  const rawLimit = typeof raw.usageLimit    === 'number' ? raw.usageLimit    : (raw.planLimit ?? null);
  return {
    label,
    currentUsage:    current,
    usageLimit:      formatLimit(rawLimit),
    rawUsageLimit:   rawLimit,
    usagePercentage: calculateUsagePercentage(current, rawLimit),
    isAllowed:       raw.isAllowed !== false,
    includedInPlan:  raw.includedInPlan === true,
  };
}

// ── API health check — uses x-api-key on GET /replicas ───────────────────────

async function checkApiHealth(baseUrl, apiKey) {
  const endpoint = `${baseUrl}/replicas`;
  try {
    const { statusCode, body } = await httpsGet(endpoint, { 'x-api-key': apiKey });

    if (statusCode === 200) {
      return { credentialStatus: 'Valid', apiHealth: 'Healthy', apiError: null };
    }
    if (statusCode === 401 || statusCode === 403) {
      const parsed   = tryParseJson(body);
      const detail   = parsed?.message || parsed?.error || parsed?.detail || null;
      const apiError = detail ? String(detail) : `Tavus API returned HTTP ${statusCode} — API key rejected.`;
      return { credentialStatus: 'Invalid', apiHealth: 'Auth Failed', apiError };
    }
    if (statusCode === 429) {
      return { credentialStatus: 'Valid', apiHealth: 'Rate Limited', apiError: 'Tavus API rate limit reached. Retry later.' };
    }
    if (statusCode >= 500) {
      const parsed   = tryParseJson(body);
      const detail   = parsed?.message || parsed?.error || null;
      const apiError = detail ? String(detail) : `Tavus API server error (HTTP ${statusCode}).`;
      return { credentialStatus: 'Unknown', apiHealth: 'Failed', apiError };
    }
    // 404 and other 4xx — endpoint may not exist for this plan but key was accepted
    console.info(`[Tavus] /replicas returned HTTP ${statusCode} — treating credentials as valid.`);
    return { credentialStatus: 'Valid', apiHealth: 'Healthy', apiError: null };

  } catch (e) {
    const apiError = e.message && e.message.length < 200 ? e.message : 'Network error contacting Tavus API.';
    console.warn('[Tavus] API health check error:', apiError);
    return { credentialStatus: 'Unknown', apiHealth: 'Failed', apiError };
  }
}

// ── Billing quota fetch — uses Bearer token on TAVUS_ACCOUNT_USAGE_ENDPOINT ──

async function fetchBillingQuotas(usageEndpoint, billingToken) {
  if (!usageEndpoint) {
    return { quotaStatus: 'Not Configured', quotaMessage: 'TAVUS_ACCOUNT_USAGE_ENDPOINT is not configured. Showing plan information only.', quotas: null };
  }
  if (!billingToken) {
    return { quotaStatus: 'No Token', quotaMessage: 'TAVUS_BILLING_AUTH_TOKEN is not configured. Cannot fetch billing quotas.', quotas: null };
  }

  try {
    const { statusCode, body } = await httpsGet(usageEndpoint, { 'Authorization': `Bearer ${billingToken}` });

    if (statusCode === 401 || statusCode === 403) {
      return { quotaStatus: 'Auth Failed', quotaMessage: 'Tavus billing quota authorization failed. Verify TAVUS_BILLING_AUTH_TOKEN.', quotas: null, quotaAuthFailed: true };
    }
    if (statusCode === 404) {
      return { quotaStatus: 'Not Found', quotaMessage: 'Tavus billing quota endpoint not found. Check TAVUS_ACCOUNT_USAGE_ENDPOINT.', quotas: null };
    }
    if (statusCode === 429) {
      return { quotaStatus: 'Rate Limited', quotaMessage: 'Tavus billing quota endpoint rate limited. Retry later.', quotas: null };
    }
    if (statusCode >= 500) {
      return { quotaStatus: 'Server Error', quotaMessage: `Tavus billing quota endpoint server error (HTTP ${statusCode}).`, quotas: null };
    }
    if (statusCode !== 200) {
      return { quotaStatus: 'Unavailable', quotaMessage: `Tavus billing quota endpoint returned HTTP ${statusCode}.`, quotas: null };
    }

    const raw = tryParseJson(body);
    if (!raw || typeof raw !== 'object') {
      return { quotaStatus: 'Parse Error', quotaMessage: 'Tavus billing quota endpoint returned non-JSON response.', quotas: null };
    }

    const quotas = {
      conversation:             normaliseQuotaItem(raw.conversation,              'CVI / Conversation Minutes'),
      replica:                  normaliseQuotaItem(raw.replica,                   'Custom Replicas'),
      video:                    normaliseQuotaItem(raw.video,                     'Video Generation'),
      concurrentConversations:  normaliseQuotaItem(raw.concurrent_conversations_limit, 'Max Concurrent Streams'),
      conversationLengthLimit:  normaliseQuotaItem(raw.conversation_length_limit, 'Conversation Length Limit'),
    };

    // Drop quota keys that had no data
    for (const k of Object.keys(quotas)) {
      if (quotas[k] === null) delete quotas[k];
    }

    return { quotaStatus: 'Available', quotaMessage: null, quotas, quotaAuthFailed: false };

  } catch (e) {
    const msg = e.message && e.message.length < 200 ? e.message : 'Network error fetching Tavus billing quotas.';
    console.warn('[Tavus] Billing quota fetch error:', msg);
    return { quotaStatus: 'Error', quotaMessage: `Error fetching billing quotas: ${msg}`, quotas: null };
  }
}

// ── Overall status determination ──────────────────────────────────────────────

function determineStatus(credentialStatus, apiHealth, quotaResult, warningPct, criticalPct) {
  // API key invalid — hard block
  if (credentialStatus === 'Invalid') {
    return { status: 'Blocked', message: 'Tavus API key is invalid. Verify TAVUS_API_KEY.' };
  }
  // API health failures — block or critical
  if (apiHealth === 'Auth Failed') {
    return { status: 'Blocked', message: 'Tavus API key is invalid. Verify TAVUS_API_KEY.' };
  }
  if (apiHealth === 'Failed') {
    return { status: 'Critical', message: 'Tavus API server is unreachable or returning server errors.' };
  }
  if (apiHealth === 'Rate Limited') {
    return { status: 'Critical', message: 'Tavus API rate limit reached. Retry later.' };
  }

  // Billing quota auth failure — warning only (API health still works)
  if (quotaResult.quotaAuthFailed) {
    return { status: 'Warning', message: 'Tavus billing quota authorization failed. Verify TAVUS_BILLING_AUTH_TOKEN.' };
  }

  // Missing billing token — warning only
  if (quotaResult.quotaStatus === 'No Token') {
    return { status: 'Warning', message: 'TAVUS_BILLING_AUTH_TOKEN is not configured. Billing quota monitoring is unavailable.' };
  }

  // Check per-quota item status
  if (quotaResult.quotas) {
    for (const item of Object.values(quotaResult.quotas)) {
      if (!item.isAllowed) {
        return { status: 'Blocked', message: `Tavus quota "${item.label}" is not allowed. Usage limit may be exhausted.` };
      }
      const pct = item.usagePercentage;
      if (pct !== null) {
        if (pct >= 100) {
          return { status: 'Blocked', message: `Tavus quota "${item.label}" is fully consumed (${pct}%).` };
        }
        if (pct >= criticalPct) {
          return { status: 'Critical', message: `Tavus quota "${item.label}" crossed ${criticalPct}% (${pct}%). Please upgrade or add capacity immediately.` };
        }
        if (pct >= warningPct) {
          return { status: 'Warning', message: `Tavus quota "${item.label}" crossed ${warningPct}% (${pct}%). Please monitor usage.` };
        }
      }
    }
  }

  if (quotaResult.quotaStatus === 'Available') {
    return { status: 'Normal', message: 'Tavus API service is normal.' };
  }

  // No usage data but API is healthy — normal for enterprise or unconfigured endpoint
  return { status: 'Normal', message: 'Tavus API is healthy. Billing quota data is not available.' };
}

// ── Main export ───────────────────────────────────────────────────────────────

async function fetchTavusStatus() {
  const apiKey        = process.env.TAVUS_API_KEY;
  const baseUrl       = (process.env.TAVUS_BASE_URL || 'https://tavusapi.com/v2').replace(/\/$/, '');
  const usageEndpoint = process.env.TAVUS_ACCOUNT_USAGE_ENDPOINT || null;
  const billingToken  = process.env.TAVUS_BILLING_AUTH_TOKEN || null;
  const warningPct    = Number.parseInt(process.env.TAVUS_WARNING_PERCENTAGE  || '75', 10);
  const criticalPct   = Number.parseInt(process.env.TAVUS_CRITICAL_PERCENTAGE || '90', 10);
  const envPlanName   = process.env.TAVUS_PLAN_NAME || null;
  const envLimitType  = process.env.TAVUS_LIMIT_TYPE || null;
  const isEnterprise  = (envPlanName || '').toLowerCase() === 'enterprise';

  if (!apiKey) {
    const err = new Error('TAVUS_API_KEY is not configured.');
    err.configError = true;
    throw err;
  }

  const [healthResult, quotaResult] = await Promise.all([
    checkApiHealth(baseUrl, apiKey),
    fetchBillingQuotas(usageEndpoint, billingToken),
  ]);

  if (healthResult.credentialStatus === 'Invalid') {
    const err = new Error('Tavus API key is invalid. Verify TAVUS_API_KEY.');
    err.authError = true;
    throw err;
  }

  const { status, message } = determineStatus(
    healthResult.credentialStatus,
    healthResult.apiHealth,
    quotaResult,
    warningPct,
    criticalPct
  );

  const planName  = envPlanName  || 'Unknown';
  const limitType = envLimitType || (isEnterprise ? 'Custom Enterprise' : null);

  // usageStatus exposed to frontend
  const usageStatus = quotaResult.quotaStatus === 'Available' ? 'Available'
    : quotaResult.quotaStatus === 'Not Configured' ? (isEnterprise ? 'Not Available via API' : 'Not Configured')
    : quotaResult.quotaStatus;

  return {
    provider:         'Tavus',
    portal:           'https://platform.tavus.io',
    apiBaseUrl:       baseUrl,
    credentialStatus: healthResult.credentialStatus,
    apiHealth:        healthResult.apiHealth,
    apiError:         healthResult.apiError || null,
    planName,
    limitType,
    enterprisePlan:   isEnterprise,
    usageStatus,
    usageMessage:     quotaResult.quotaMessage || null,
    // Individual quota items (null when billing endpoint not available)
    ...(quotaResult.quotas || {}),
    warningPercentage:  warningPct,
    criticalPercentage: criticalPct,
    lastCheckedTime:    new Date().toISOString(),
    lastErrorCode:      _lastError.code,
    lastErrorMessage:   _lastError.message,
    lastErrorTime:      _lastError.time,
    status,
    message,
  };
}

// ── Tavus API pre-check ───────────────────────────────────────────────────────

function checkTavusAllowed(statusData) {
  if (statusData.status === 'Blocked') {
    return {
      allowed: false,
      reason: 'Tavus service is temporarily unavailable due to API key, quota limit, or service health issue. Please contact admin.',
    };
  }
  if (statusData.status === 'Critical') {
    // Usage-only critical (API itself is Healthy) — allow but log alert
    if (statusData.apiHealth === 'Healthy') {
      console.warn('[Tavus] Request allowed but quota is Critical. Review plan immediately.');
      return { allowed: true, reason: null };
    }
    // API health failure — block
    return {
      allowed: false,
      reason: 'Tavus API is not reachable or is rate limited. Please retry later.',
    };
  }
  return { allowed: true, reason: null };
}

module.exports = { fetchTavusStatus, checkTavusAllowed, recordTavusError };
