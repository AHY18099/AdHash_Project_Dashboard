'use strict';

const https = require('node:https');

// ── In-memory caches (reset on redeploy — no DB needed) ──────────────────────
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

// ── API health + credential check ────────────────────────────────────────────

async function checkApiHealth(baseUrl, apiKey) {
  const endpoint = `${baseUrl}/replicas`;
  let credentialStatus = 'Unknown';
  let apiHealth        = 'Unknown';
  let apiError         = null;

  try {
    const { statusCode, body } = await httpsGetApiKey(endpoint, apiKey);

    if (statusCode === 200) {
      credentialStatus = 'Valid';
      apiHealth        = 'Success';
    } else if (statusCode === 401 || statusCode === 403) {
      credentialStatus = 'Invalid';
      apiHealth        = 'Auth Failed';
      apiError         = `Tavus API returned HTTP ${statusCode} — API key rejected.`;
    } else if (statusCode === 429) {
      credentialStatus = 'Valid';
      apiHealth        = 'Rate Limited';
      apiError         = 'Tavus API rate limit reached. Retry later.';
    } else if (statusCode >= 500) {
      credentialStatus = 'Unknown';
      apiHealth        = 'Failed';
      apiError         = `Tavus API server error (HTTP ${statusCode}).`;
    } else {
      // 404 on /replicas could mean the key is valid but replicas is not in the plan
      credentialStatus = 'Valid';
      apiHealth        = 'Success';
      console.info(`[Tavus] /replicas returned HTTP ${statusCode} — treating credentials as valid.`);
    }

    // Try to extract a useful error message from the body
    if (apiError) {
      try {
        const parsed = JSON.parse(body);
        const detail = parsed?.message || parsed?.error || parsed?.detail || null;
        if (detail) apiError = String(detail);
      } catch { /* ignore */ }
    }
  } catch (e) {
    apiHealth  = 'Failed';
    apiError   = e.message && e.message.length < 200 ? e.message : 'Network error contacting Tavus API.';
    console.warn('[Tavus] API health check error:', apiError);
  }

  return { credentialStatus, apiHealth, apiError };
}

// ── Optional usage fetch ──────────────────────────────────────────────────────

async function fetchUsage(usageEndpoint, apiKey, warningPct, criticalPct) {
  if (!usageEndpoint) {
    return {
      usageStatus: 'Not Available',
      conversationMinutesUsed:      null,
      conversationMinutesLimit:     null,
      conversationMinutesRemaining: null,
      videoGenerationMinutesUsed:   null,
      videoGenerationMinutesLimit:  null,
      videoGenerationMinutesRemaining: null,
      usagePercentage: null,
      usageMessage: 'TAVUS_ACCOUNT_USAGE_ENDPOINT is not configured. Usage monitoring is not available.',
    };
  }

  try {
    const { statusCode, body } = await httpsGetApiKey(usageEndpoint, apiKey);
    if (statusCode !== 200) {
      return {
        usageStatus: 'Not Available',
        conversationMinutesUsed:      null,
        conversationMinutesLimit:     null,
        conversationMinutesRemaining: null,
        videoGenerationMinutesUsed:   null,
        videoGenerationMinutesLimit:  null,
        videoGenerationMinutesRemaining: null,
        usagePercentage: null,
        usageMessage: `Usage endpoint returned HTTP ${statusCode}. Usage monitoring is not available.`,
      };
    }

    let raw = null;
    try { raw = JSON.parse(body); } catch { /* fall through */ }
    if (!raw) {
      return {
        usageStatus: 'Not Available',
        conversationMinutesUsed:      null,
        conversationMinutesLimit:     null,
        conversationMinutesRemaining: null,
        videoGenerationMinutesUsed:   null,
        videoGenerationMinutesLimit:  null,
        videoGenerationMinutesRemaining: null,
        usagePercentage: null,
        usageMessage: 'Usage endpoint returned non-JSON response.',
      };
    }

    // Probe common field names (Tavus API structure may vary by plan)
    const src = raw.data ?? raw;
    const convUsed  = src.conversation_minutes_used  ?? src.conversationMinutesUsed  ?? null;
    const convLimit = src.conversation_minutes_limit ?? src.conversationMinutesLimit ?? null;
    const vidUsed   = src.video_generation_minutes_used  ?? src.videoGenerationMinutesUsed  ?? null;
    const vidLimit  = src.video_generation_minutes_limit ?? src.videoGenerationMinutesLimit ?? null;

    const convUsedN  = convUsed  !== null ? Number(convUsed)  : null;
    const convLimitN = convLimit !== null ? Number(convLimit) : null;
    const vidUsedN   = vidUsed   !== null ? Number(vidUsed)   : null;
    const vidLimitN  = vidLimit  !== null ? Number(vidLimit)  : null;

    const convRemaining = (convUsedN !== null && convLimitN !== null) ? Math.max(0, convLimitN - convUsedN) : null;
    const vidRemaining  = (vidUsedN  !== null && vidLimitN  !== null) ? Math.max(0, vidLimitN  - vidUsedN)  : null;

    // Determine highest usage percentage across available metrics
    let usagePercentage = null;
    if (convUsedN !== null && convLimitN !== null && convLimitN > 0) {
      usagePercentage = Math.max(usagePercentage ?? 0, Number(((convUsedN / convLimitN) * 100).toFixed(2)));
    }
    if (vidUsedN !== null && vidLimitN !== null && vidLimitN > 0) {
      usagePercentage = Math.max(usagePercentage ?? 0, Number(((vidUsedN / vidLimitN) * 100).toFixed(2)));
    }

    return {
      usageStatus: 'Available',
      conversationMinutesUsed:         convUsedN,
      conversationMinutesLimit:        convLimitN,
      conversationMinutesRemaining:    convRemaining,
      videoGenerationMinutesUsed:      vidUsedN,
      videoGenerationMinutesLimit:     vidLimitN,
      videoGenerationMinutesRemaining: vidRemaining,
      usagePercentage,
      usageMessage: null,
    };
  } catch (e) {
    const msg = e.message && e.message.length < 200 ? e.message : 'Error fetching Tavus usage data.';
    console.warn('[Tavus] Usage fetch error:', msg);
    return {
      usageStatus: 'Not Available',
      conversationMinutesUsed:      null,
      conversationMinutesLimit:     null,
      conversationMinutesRemaining: null,
      videoGenerationMinutesUsed:   null,
      videoGenerationMinutesLimit:  null,
      videoGenerationMinutesRemaining: null,
      usagePercentage: null,
      usageMessage: `Error fetching usage: ${msg}`,
    };
  }
}

// ── Overall status ────────────────────────────────────────────────────────────

function determineStatus(credentialStatus, apiHealth, usagePercentage, warningPct, criticalPct) {
  if (credentialStatus === 'Invalid') {
    return { status: 'Blocked', message: 'Tavus API key is invalid. Please verify TAVUS_API_KEY.' };
  }
  if (apiHealth === 'Failed') {
    return { status: 'Critical', message: 'Tavus API server is unreachable or returning server errors.' };
  }
  if (apiHealth === 'Rate Limited') {
    return { status: 'Critical', message: 'Tavus API rate limit reached. Retry later.' };
  }
  if (usagePercentage !== null) {
    if (usagePercentage >= 100) {
      return { status: 'Blocked', message: 'Tavus usage limit is fully consumed. Please review your plan.' };
    }
    if (usagePercentage >= criticalPct) {
      return { status: 'Critical', message: `Tavus usage crossed ${criticalPct}%. Please review your plan immediately.` };
    }
    if (usagePercentage >= warningPct) {
      return { status: 'Warning', message: `Tavus usage crossed ${warningPct}%. Please monitor.` };
    }
  }
  return { status: 'Normal', message: 'Tavus API service is normal.' };
}

// ── Main export ───────────────────────────────────────────────────────────────

async function fetchTavusStatus() {
  const apiKey         = process.env.TAVUS_API_KEY;
  const baseUrl        = (process.env.TAVUS_BASE_URL || 'https://tavusapi.com/v2').replace(/\/$/, '');
  const usageEndpoint  = process.env.TAVUS_ACCOUNT_USAGE_ENDPOINT || null;
  const warningPct     = Number.parseInt(process.env.TAVUS_WARNING_PERCENTAGE  || '75', 10);
  const criticalPct    = Number.parseInt(process.env.TAVUS_CRITICAL_PERCENTAGE || '90', 10);

  if (!apiKey) {
    const err = new Error('TAVUS_API_KEY is not configured.');
    err.configError = true;
    throw err;
  }

  // Manual plan limits from env (used when no usage endpoint)
  const planName               = process.env.TAVUS_PLAN_NAME                    || null;
  const convMinutesLimit       = process.env.TAVUS_CONVERSATION_MINUTES_LIMIT   ? Number(process.env.TAVUS_CONVERSATION_MINUTES_LIMIT)   : null;
  const videoMinutesLimit      = process.env.TAVUS_VIDEO_GENERATION_MINUTES_LIMIT ? Number(process.env.TAVUS_VIDEO_GENERATION_MINUTES_LIMIT) : null;
  const concurrentStreamLimit  = process.env.TAVUS_CONCURRENT_STREAM_LIMIT      ? Number(process.env.TAVUS_CONCURRENT_STREAM_LIMIT)      : null;

  const [healthResult, usageResult] = await Promise.all([
    checkApiHealth(baseUrl, apiKey),
    fetchUsage(usageEndpoint, apiKey, warningPct, criticalPct),
  ]);

  if (healthResult.credentialStatus === 'Invalid') {
    const err = new Error('Tavus API key is invalid. Verify TAVUS_API_KEY.');
    err.authError = true;
    throw err;
  }

  const { status, message } = determineStatus(
    healthResult.credentialStatus,
    healthResult.apiHealth,
    usageResult.usagePercentage,
    warningPct,
    criticalPct
  );

  return {
    provider:         'Tavus',
    portal:           'https://platform.tavus.io',
    apiBaseUrl:       baseUrl,
    credentialStatus: healthResult.credentialStatus,
    apiHealth:        healthResult.apiHealth,
    apiError:         healthResult.apiError || null,
    planName:         planName || 'Unknown',
    usageStatus:      usageResult.usageStatus,
    conversationMinutesUsed:         usageResult.conversationMinutesUsed,
    conversationMinutesLimit:        usageResult.conversationMinutesLimit  ?? convMinutesLimit,
    conversationMinutesRemaining:    usageResult.conversationMinutesRemaining,
    videoGenerationMinutesUsed:      usageResult.videoGenerationMinutesUsed,
    videoGenerationMinutesLimit:     usageResult.videoGenerationMinutesLimit ?? videoMinutesLimit,
    videoGenerationMinutesRemaining: usageResult.videoGenerationMinutesRemaining,
    concurrentStreamLimit:           concurrentStreamLimit,
    usagePercentage:  usageResult.usagePercentage,
    usageMessage:     usageResult.usageMessage || null,
    warningThreshold: warningPct,
    criticalThreshold: criticalPct,
    lastCheckedTime:  new Date().toISOString(),
    lastErrorCode:    _lastError.code,
    lastErrorMessage: _lastError.message,
    lastErrorTime:    _lastError.time,
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
    if (statusData.apiHealth !== 'Success') {
      return {
        allowed: false,
        reason: 'Tavus API is not reachable or is rate limited. Please retry later.',
      };
    }
    console.warn('[Tavus] Request allowed but usage is Critical. Review plan.');
  }
  return { allowed: true, reason: null };
}

module.exports = { fetchTavusStatus, checkTavusAllowed, recordTavusError };
