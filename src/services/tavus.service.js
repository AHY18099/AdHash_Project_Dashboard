'use strict';

// Tavus real usage monitoring requires an official usage endpoint.
// If Tavus provides account usage API, configure TAVUS_ACCOUNT_USAGE_ENDPOINT in Railway.

const https = require('node:https');

// ── In-memory last-error cache (reset on redeploy — no DB needed) ────────────
const _lastError = { code: null, message: null, time: null };

function recordTavusError(code, message) {
  _lastError.code    = code    || null;
  _lastError.message = message || null;
  _lastError.time    = new Date().toISOString();
  console.error(`[Tavus Error] ${code}: ${message}`);
}

// ── HTTP helper — x-api-key GET ───────────────────────────────────────────────

function httpsGetApiKey(endpoint, apiKey) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const options = {
      hostname: url.hostname,
      port:     url.port || 443,
      path:     url.pathname + url.search,
      method:   'GET',
      headers: {
        'x-api-key': apiKey,
        'Accept':    'application/json',
      },
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

// ── Coerce value to finite number or null ─────────────────────────────────────

function toNum(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── API health + credential check ────────────────────────────────────────────
// Uses GET /replicas as a lightweight authenticated probe.

async function checkApiHealth(baseUrl, apiKey) {
  const endpoint = `${baseUrl}/replicas`;
  try {
    const { statusCode, body } = await httpsGetApiKey(endpoint, apiKey);

    if (statusCode === 200) {
      return { credentialStatus: 'Valid', apiHealth: 'Healthy', apiError: null };
    }
    if (statusCode === 401 || statusCode === 403) {
      const parsed  = tryParseJson(body);
      const detail  = parsed?.message || parsed?.error || parsed?.detail || null;
      const apiError = detail ? String(detail) : `Tavus API returned HTTP ${statusCode} — API key rejected.`;
      return { credentialStatus: 'Invalid', apiHealth: 'Auth Failed', apiError };
    }
    if (statusCode === 429) {
      return { credentialStatus: 'Valid', apiHealth: 'Rate Limited', apiError: 'Tavus API rate limit reached. Retry later.' };
    }
    if (statusCode >= 500) {
      const parsed  = tryParseJson(body);
      const detail  = parsed?.message || parsed?.error || null;
      const apiError = detail ? String(detail) : `Tavus API server error (HTTP ${statusCode}).`;
      return { credentialStatus: 'Unknown', apiHealth: 'Failed', apiError };
    }
    // 404 and other 4xx — endpoint may not exist for this plan but key is accepted
    console.info(`[Tavus] /replicas returned HTTP ${statusCode} — treating credentials as valid.`);
    return { credentialStatus: 'Valid', apiHealth: 'Healthy', apiError: null };

  } catch (e) {
    const apiError = e.message && e.message.length < 200 ? e.message : 'Network error contacting Tavus API.';
    console.warn('[Tavus] API health check error:', apiError);
    return { credentialStatus: 'Unknown', apiHealth: 'Failed', apiError };
  }
}

// ── Flexible usage field probe ────────────────────────────────────────────────
// Tavus usage API shape is undocumented and may vary by plan. Probe all likely
// field names and pick the first non-null numeric value for each metric.

function probeField(src, ...keys) {
  for (const k of keys) {
    const v = src[k];
    const n = toNum(v);
    if (n !== null) return n;
  }
  return null;
}

function extractUsageFields(raw) {
  // Normalise: support top-level or nested .data
  const src = (raw && typeof raw === 'object' && raw.data && typeof raw.data === 'object')
    ? { ...raw, ...raw.data }
    : (raw || {});

  const planName = src.plan_name ?? src.plan ?? src.planName ?? null;

  const convUsed  = probeField(src, 'conversation_minutes_used',  'conversationMinutesUsed',  'minutes_used',  'credits_used',  'usage');
  const convLimit = probeField(src, 'conversation_minutes_limit', 'conversationMinutesLimit', 'minutes_limit', 'credits_limit', 'limit');
  const vidUsed   = probeField(src, 'video_generation_minutes_used',  'videoGenerationMinutesUsed');
  const vidLimit  = probeField(src, 'video_generation_minutes_limit', 'videoGenerationMinutesLimit');
  const concLimit = probeField(src, 'concurrent_stream_limit', 'concurrentStreamLimit', 'concurrent_streams');

  const convRemaining = (convUsed !== null && convLimit !== null) ? Math.max(0, convLimit - convUsed) : null;
  const vidRemaining  = (vidUsed  !== null && vidLimit  !== null) ? Math.max(0, vidLimit  - vidUsed)  : null;

  const convPct = (convUsed !== null && convLimit !== null && convLimit > 0)
    ? Number(((convUsed / convLimit) * 100).toFixed(2)) : null;
  const vidPct  = (vidUsed !== null && vidLimit  !== null && vidLimit  > 0)
    ? Number(((vidUsed  / vidLimit)  * 100).toFixed(2)) : null;

  // Overall = highest available percentage
  let overallPct = null;
  if (convPct !== null) overallPct = Math.max(overallPct ?? 0, convPct);
  if (vidPct  !== null) overallPct = Math.max(overallPct ?? 0, vidPct);

  return {
    planName:                        typeof planName === 'string' ? planName : null,
    conversationMinutesUsed:         convUsed,
    conversationMinutesLimit:        convLimit,
    conversationMinutesRemaining:    convRemaining,
    conversationUsagePercentage:     convPct,
    videoGenerationMinutesUsed:      vidUsed,
    videoGenerationMinutesLimit:     vidLimit,
    videoGenerationMinutesRemaining: vidRemaining,
    videoGenerationUsagePercentage:  vidPct,
    overallUsagePercentage:          overallPct,
    concurrentStreamLimit:           concLimit,
  };
}

// ── Usage endpoint fetch ──────────────────────────────────────────────────────

async function fetchUsage(usageEndpoint, apiKey) {
  if (!usageEndpoint) {
    return {
      usageStatus:  'Not Available',
      usageMessage: 'TAVUS_ACCOUNT_USAGE_ENDPOINT is not configured. Showing manual plan limits only.',
      ...emptyUsageFields(),
    };
  }

  try {
    const { statusCode, body } = await httpsGetApiKey(usageEndpoint, apiKey);

    if (statusCode === 401 || statusCode === 403) {
      return {
        usageStatus:  'Unavailable',
        usageMessage: 'Tavus usage endpoint authorization failed. Please verify API key.',
        usageAuthFailed: true,
        ...emptyUsageFields(),
      };
    }
    if (statusCode === 404) {
      return {
        usageStatus:  'Not Available',
        usageMessage: 'Tavus usage endpoint is not available for this account or endpoint path.',
        ...emptyUsageFields(),
      };
    }
    if (statusCode !== 200) {
      return {
        usageStatus:  'Not Available',
        usageMessage: `Tavus usage endpoint returned HTTP ${statusCode}. Usage monitoring is not available.`,
        ...emptyUsageFields(),
      };
    }

    const raw = tryParseJson(body);
    if (!raw) {
      return {
        usageStatus:  'Not Available',
        usageMessage: 'Tavus usage endpoint returned a non-JSON response.',
        ...emptyUsageFields(),
      };
    }

    const fields = extractUsageFields(raw);

    // Consider "available" if at least one numeric usage or limit field was found
    const hasData = Object.values(fields).some(v => typeof v === 'number');
    if (!hasData) {
      return {
        usageStatus:  'Not Available',
        usageMessage: 'Tavus usage endpoint returned 200 but no recognisable usage fields were found.',
        ...emptyUsageFields(),
      };
    }

    return {
      usageStatus:  'Available',
      usageMessage: null,
      usageAuthFailed: false,
      ...fields,
    };

  } catch (e) {
    const msg = e.message && e.message.length < 200 ? e.message : 'Network error fetching Tavus usage.';
    console.warn('[Tavus] Usage fetch error:', msg);
    return {
      usageStatus:  'Not Available',
      usageMessage: `Error fetching usage: ${msg}`,
      ...emptyUsageFields(),
    };
  }
}

function emptyUsageFields() {
  return {
    usageAuthFailed:                 false,
    planName:                        null,
    conversationMinutesUsed:         null,
    conversationMinutesLimit:        null,
    conversationMinutesRemaining:    null,
    conversationUsagePercentage:     null,
    videoGenerationMinutesUsed:      null,
    videoGenerationMinutesLimit:     null,
    videoGenerationMinutesRemaining: null,
    videoGenerationUsagePercentage:  null,
    overallUsagePercentage:          null,
    concurrentStreamLimit:           null,
  };
}

// ── Overall status ────────────────────────────────────────────────────────────

function determineStatus(credentialStatus, apiHealth, usageStatus, usageAuthFailed, overallPct, warningPct, criticalPct) {
  if (credentialStatus === 'Invalid' || usageAuthFailed) {
    return { status: 'Blocked', message: 'Tavus usage limit is fully consumed or API key is invalid.' };
  }
  if (apiHealth === 'Failed') {
    return { status: 'Critical', message: 'Tavus API server is unreachable or returning server errors.' };
  }
  if (apiHealth === 'Rate Limited') {
    return { status: 'Critical', message: 'Tavus API rate limit reached. Retry later.' };
  }
  if (overallPct !== null) {
    if (overallPct >= 100) {
      return { status: 'Blocked', message: 'Tavus usage limit is fully consumed or API key is invalid.' };
    }
    if (overallPct >= criticalPct) {
      return { status: 'Critical', message: `Tavus usage crossed ${criticalPct}%. Please upgrade or add usage immediately.` };
    }
    if (overallPct >= warningPct) {
      return { status: 'Warning', message: `Tavus usage crossed ${warningPct}%. Please monitor usage.` };
    }
  }
  if (usageStatus === 'Not Available') {
    return { status: 'Normal', message: 'Tavus API is healthy. Usage data is not available because usage endpoint is not configured.' };
  }
  return { status: 'Normal', message: 'Tavus API service is normal.' };
}

// ── Main export ───────────────────────────────────────────────────────────────

async function fetchTavusStatus() {
  const apiKey        = process.env.TAVUS_API_KEY;
  const baseUrl       = (process.env.TAVUS_BASE_URL || 'https://tavusapi.com/v2').replace(/\/$/, '');
  const usageEndpoint = process.env.TAVUS_ACCOUNT_USAGE_ENDPOINT || null;
  const warningPct    = Number.parseInt(process.env.TAVUS_WARNING_PERCENTAGE  || '75', 10);
  const criticalPct   = Number.parseInt(process.env.TAVUS_CRITICAL_PERCENTAGE || '90', 10);

  if (!apiKey) {
    const err = new Error('TAVUS_API_KEY is not configured.');
    err.configError = true;
    throw err;
  }

  // Manual plan limits from env — shown when usage endpoint is absent
  const envPlanName        = process.env.TAVUS_PLAN_NAME || null;
  const envConvLimit       = toNum(process.env.TAVUS_CONVERSATION_MINUTES_LIMIT);
  const envVideoLimit      = toNum(process.env.TAVUS_VIDEO_GENERATION_MINUTES_LIMIT);
  const envConcurrentLimit = toNum(process.env.TAVUS_CONCURRENT_STREAM_LIMIT);

  const [healthResult, usageResult] = await Promise.all([
    checkApiHealth(baseUrl, apiKey),
    fetchUsage(usageEndpoint, apiKey),
  ]);

  if (healthResult.credentialStatus === 'Invalid') {
    const err = new Error('Tavus API key is invalid. Verify TAVUS_API_KEY.');
    err.authError = true;
    throw err;
  }

  const { status, message } = determineStatus(
    healthResult.credentialStatus,
    healthResult.apiHealth,
    usageResult.usageStatus,
    !!usageResult.usageAuthFailed,
    usageResult.overallUsagePercentage,
    warningPct,
    criticalPct
  );

  // Merge usage-endpoint results with env-based manual limits as fallbacks
  const planName              = usageResult.planName              ?? envPlanName        ?? 'Unknown';
  const convLimit             = usageResult.conversationMinutesLimit   ?? envConvLimit;
  const videoLimit            = usageResult.videoGenerationMinutesLimit ?? envVideoLimit;
  const concurrentStreamLimit = usageResult.concurrentStreamLimit  ?? envConcurrentLimit;

  return {
    provider:         'Tavus',
    portal:           'https://platform.tavus.io',
    apiBaseUrl:       baseUrl,
    credentialStatus: healthResult.credentialStatus,
    apiHealth:        healthResult.apiHealth,
    apiError:         healthResult.apiError || null,
    planName,
    usageStatus:      usageResult.usageStatus,
    usageMessage:     usageResult.usageMessage || null,
    conversationMinutesUsed:         usageResult.conversationMinutesUsed,
    conversationMinutesLimit:        convLimit,
    conversationMinutesRemaining:    usageResult.conversationMinutesRemaining,
    conversationUsagePercentage:     usageResult.conversationUsagePercentage,
    videoGenerationMinutesUsed:      usageResult.videoGenerationMinutesUsed,
    videoGenerationMinutesLimit:     videoLimit,
    videoGenerationMinutesRemaining: usageResult.videoGenerationMinutesRemaining,
    videoGenerationUsagePercentage:  usageResult.videoGenerationUsagePercentage,
    overallUsagePercentage:          usageResult.overallUsagePercentage,
    concurrentStreamLimit,
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
      reason: 'Tavus service is temporarily unavailable because API key, usage limit, or Tavus service health has an issue. Please contact admin.',
    };
  }
  if (statusData.status === 'Critical') {
    // Usage-only critical (apiHealth is Healthy) — allow but log warning
    if (statusData.apiHealth === 'Healthy') {
      console.warn('[Tavus] Request allowed but usage is Critical. Review plan immediately.');
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
