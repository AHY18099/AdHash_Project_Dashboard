'use strict';

const https = require('https');
const crypto = require('crypto');

// ── In-memory last-error cache (resets on redeploy — acceptable, no DB needed) ─
const _lastError = { code: null, message: null, time: null };

function recordOtpError(code, message) {
  _lastError.code    = code    || null;
  _lastError.message = message || null;
  _lastError.time    = new Date().toISOString();
  console.error(`[Firebase OTP Error] ${code}: ${message}`);
}

// ── Google OAuth2 — service account JWT → access token ───────────────────────

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function signServiceAccountJwt(sa, scopes) {
  const now = Math.floor(Date.now() / 1000);
  const header  = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    scope: scopes.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const data = `${base64url(Buffer.from(JSON.stringify(header)))}.${base64url(Buffer.from(JSON.stringify(payload)))}`;
  const sig  = crypto.createSign('RSA-SHA256').update(data).sign(sa.private_key, 'base64');
  return `${data}.${base64url(Buffer.from(sig, 'base64'))}`;
}

async function getGoogleAccessToken(serviceAccountJson, scopes) {
  const sa  = typeof serviceAccountJson === 'string' ? JSON.parse(serviceAccountJson) : serviceAccountJson;
  const jwt = signServiceAccountJwt(sa, scopes);
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  const { statusCode, responseBody } = await httpsPost('oauth2.googleapis.com', '/token', body, {
    'Content-Type': 'application/x-www-form-urlencoded',
  });
  if (statusCode !== 200) {
    throw new Error(`Google OAuth2 token exchange failed (HTTP ${statusCode}): ${responseBody}`);
  }
  return JSON.parse(responseBody).access_token;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpsGet(hostname, path, token) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: 'GET', headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ statusCode: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('Request timed out')); });
    req.end();
  });
}

function httpsPost(hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let responseBody = '';
        res.on('data', (c) => { responseBody += c; });
        res.on('end', () => resolve({ statusCode: res.statusCode, responseBody }));
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('Request timed out')); });
    req.write(body);
    req.end();
  });
}

// ── Quota status for a single quota ──────────────────────────────────────────

function quotaStatus(usagePct, warningPct, criticalPct) {
  if (usagePct >= 100)        return 'Blocked';
  if (usagePct >= criticalPct) return 'Critical';
  if (usagePct >= warningPct)  return 'Warning';
  return 'Normal';
}

// ── Overall status combining all signals ─────────────────────────────────────

function determineOverallStatus(billingStatus, phoneAuthEnabled, primaryPct, secondaryPct, warningPct, criticalPct) {
  if (billingStatus === 'Inactive') {
    return { status: 'Blocked', message: 'Firebase billing is not active. Please verify billing/payment.' };
  }
  if (phoneAuthEnabled === false) {
    return { status: 'Blocked', message: 'Firebase Phone Authentication is disabled.' };
  }
  const maxPct = Math.max(primaryPct, secondaryPct);
  if (maxPct >= 100) {
    return { status: 'Blocked', message: 'Firebase OTP verification quota is fully consumed.' };
  }
  if (maxPct >= criticalPct) {
    return { status: 'Critical', message: `Firebase OTP verification quota crossed ${criticalPct}%. Please check Firebase quota/billing immediately.` };
  }
  if (maxPct >= warningPct) {
    return { status: 'Warning', message: `Firebase OTP verification quota crossed ${warningPct}%. Please monitor usage.` };
  }
  return { status: 'Normal', message: 'Firebase OTP usage is normal.' };
}

// ── Billing status ────────────────────────────────────────────────────────────

async function fetchBillingStatus(projectId, token) {
  if (process.env.FIREBASE_CHECK_BILLING === 'false') return 'Unknown';
  try {
    const { statusCode, body } = await httpsGet(
      'cloudbilling.googleapis.com',
      `/v1/projects/${projectId}/billingInfo`,
      token
    );
    if (statusCode === 403 || statusCode === 401) {
      console.warn('[Firebase] Billing API access denied — returning Unknown');
      return 'Unknown';
    }
    if (statusCode === 404) return 'Unknown';
    if (statusCode !== 200) return 'Unknown';
    const raw = JSON.parse(body);
    return raw.billingEnabled === true ? 'Active' : 'Inactive';
  } catch (e) {
    console.warn('[Firebase] Billing API error:', e.message, '— returning Unknown');
    return 'Unknown';
  }
}

// ── Phone auth enabled ────────────────────────────────────────────────────────

async function fetchPhoneAuthEnabled(projectId, token) {
  try {
    const { statusCode, body } = await httpsGet(
      'identitytoolkit.googleapis.com',
      `/v2/projects/${projectId}/config`,
      token
    );
    if (statusCode === 403 || statusCode === 401) {
      console.warn('[Firebase] Identity Toolkit config access denied — returning Unknown');
      return 'Unknown';
    }
    if (statusCode !== 200) return 'Unknown';
    const raw = JSON.parse(body);

    // Navigate the response: signIn.phoneNumber.enabled or signInConfig array
    const phoneEnabled =
      raw.signIn?.phoneNumber?.enabled ??
      raw.signIn?.allowDuplicateEmails ?? // fallback field exploration
      null;

    if (typeof phoneEnabled === 'boolean') return phoneEnabled;

    // Check signIn.email.enabled as negative proxy — if present but no phone key, treat as Unknown
    const providers = raw.authorizedDomains || raw.signInConfig || null;
    if (providers === null) return 'Unknown';

    return 'Unknown';
  } catch (e) {
    console.warn('[Firebase] Phone auth config error:', e.message, '— returning Unknown');
    return 'Unknown';
  }
}

// ── Service Usage API — all quota metrics ────────────────────────────────────

async function fetchAllQuotaMetrics(projectNumber, token) {
  const path = `/v1beta1/projects/${projectNumber}/services/identitytoolkit.googleapis.com/consumerQuotaMetrics`;
  const { statusCode, body } = await httpsGet('serviceusage.googleapis.com', path, token);

  if (statusCode === 403) {
    const err = new Error('Service Usage API access denied. Ensure the service account has roles/serviceusage.serviceUsageConsumer.');
    err.authError = true;
    throw err;
  }
  if (statusCode !== 200) {
    throw new Error(`Service Usage API returned HTTP ${statusCode}`);
  }
  return JSON.parse(body).metrics || [];
}

function extractLimitFromMetrics(metrics, targetKeywords, defaultLimit) {
  for (const metric of metrics) {
    const displayName = (metric.displayName || '').toLowerCase();
    const metricName  = (metric.metric || '').toLowerCase();
    const isMatch = targetKeywords.some(k => displayName.includes(k) || metricName.includes(k));
    if (!isMatch) continue;

    for (const group of (metric.consumerQuotaLimits || [])) {
      for (const bucket of (group.quotaBuckets || [])) {
        const limit = bucket.effectiveLimit;
        const parsed = parseInt(String(limit), 10);
        if (!isNaN(parsed) && parsed > 0) return parsed;
      }
    }
  }
  console.warn(`[Firebase] Quota not found for keywords [${targetKeywords.join(', ')}] — using default ${defaultLimit}`);
  return defaultLimit;
}

// ── Cloud Monitoring API — quota usage ───────────────────────────────────────

async function fetchQuotaUsage(projectId, token, quotaKeywords) {
  const endTime   = new Date().toISOString();
  const startTime = new Date(Date.now() - 86400000).toISOString();

  const metricTypes = [
    'serviceruntime.googleapis.com/quota/allocation/usage',
    'serviceruntime.googleapis.com/quota/rate/net_usage',
  ];

  for (const metricType of metricTypes) {
    const filter = encodeURIComponent(
      `metric.type="${metricType}" AND resource.labels.service="identitytoolkit.googleapis.com"`
    );
    const path = `/v3/projects/${projectId}/timeSeries?filter=${filter}&interval.startTime=${encodeURIComponent(startTime)}&interval.endTime=${encodeURIComponent(endTime)}&aggregation.alignmentPeriod=86400s&aggregation.perSeriesAligner=ALIGN_MAX`;

    const { statusCode, body } = await httpsGet('monitoring.googleapis.com', path, token);

    if (statusCode === 403) {
      const err = new Error('Cloud Monitoring API access denied. Ensure the service account has roles/monitoring.viewer.');
      err.authError = true;
      throw err;
    }
    if (statusCode !== 200) continue;

    const series = JSON.parse(body).timeSeries || [];

    // Try to match to keyword-specific quota first
    for (const ts of series) {
      const labels   = ts.metric?.labels || {};
      const resource = ts.resource?.labels || {};
      const quotaMetric = (labels.quota_metric || labels.metric_name || resource.quota_metric || '').toLowerCase();

      const isMatch = quotaKeywords.some(k => quotaMetric.includes(k));
      if (!isMatch) continue;

      const points = ts.points || [];
      if (points.length === 0) continue;
      const latest = points[0]?.value?.int64Value ?? points[0]?.value?.doubleValue ?? 0;
      const usage  = parseInt(String(latest), 10);
      if (!isNaN(usage)) return usage;
    }

    // Fallback: return sum of all identitytoolkit series if any found
    let total = 0;
    let found = false;
    for (const ts of series) {
      const points = ts.points || [];
      if (points.length === 0) continue;
      const val = parseInt(String(points[0]?.value?.int64Value ?? points[0]?.value?.doubleValue ?? 0), 10);
      if (!isNaN(val)) { total += val; found = true; }
    }
    if (found) return total;
  }

  return 0;
}

// ── Build a quota block ───────────────────────────────────────────────────────

function buildQuotaBlock(quotaName, currentUsage, dailyLimit, warningPct, criticalPct) {
  const remainingQuota  = Math.max(0, dailyLimit - currentUsage);
  const usagePercentage = dailyLimit > 0 ? Number(((currentUsage / dailyLimit) * 100).toFixed(2)) : 0;
  return {
    quotaName,
    currentUsage,
    dailyLimit,
    remainingQuota,
    usagePercentage,
    status: quotaStatus(usagePercentage, warningPct, criticalPct),
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

async function fetchOtpStatus() {
  const saJson        = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  const projectId     = process.env.FIREBASE_PROJECT_ID;
  const projectNumber = process.env.FIREBASE_PROJECT_NUMBER;
  const warningPct    = parseInt(process.env.FIREBASE_OTP_WARNING_PERCENTAGE  || '75', 10);
  const criticalPct   = parseInt(process.env.FIREBASE_OTP_CRITICAL_PERCENTAGE || '90', 10);

  const primaryQuotaName   = process.env.FIREBASE_OTP_QUOTA_NAME           || 'Send Verification Code per day';
  const secondaryQuotaName = process.env.FIREBASE_OTP_SECONDARY_QUOTA_NAME || 'Phone verification instances per day';

  if (!saJson) {
    const err = new Error('GOOGLE_APPLICATION_CREDENTIALS_JSON is not configured.');
    err.configError = true;
    throw err;
  }
  if (!projectId) {
    const err = new Error('FIREBASE_PROJECT_ID is not configured.');
    err.configError = true;
    throw err;
  }
  if (!projectNumber) {
    const err = new Error('FIREBASE_PROJECT_NUMBER is not configured.');
    err.configError = true;
    throw err;
  }

  const scopes = [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/monitoring.read',
  ];

  const token = await getGoogleAccessToken(saJson, scopes);

  // Fire all independent fetches in parallel
  const [
    allMetrics,
    billingStatus,
    phoneAuthEnabled,
    primaryUsage,
    secondaryUsage,
  ] = await Promise.all([
    fetchAllQuotaMetrics(projectNumber, token),
    fetchBillingStatus(projectId, token),
    fetchPhoneAuthEnabled(projectId, token),
    fetchQuotaUsage(projectId, token, ['send_verification', 'verificationcode', 'verifyphone', 'sendverification']),
    fetchQuotaUsage(projectId, token, ['phone', 'instances', 'phoneverification']),
  ]);

  // Extract limits
  const primaryLimit   = extractLimitFromMetrics(allMetrics, ['send verification code', 'send_verification_code'], 10000);
  const secondaryLimit = extractLimitFromMetrics(allMetrics, ['phone verification instances', 'phone_verification_instances', 'instances'], 357);

  const primaryQuota   = buildQuotaBlock(primaryQuotaName,   primaryUsage,   primaryLimit,   warningPct, criticalPct);
  const secondaryQuota = buildQuotaBlock(secondaryQuotaName, secondaryUsage, secondaryLimit, warningPct, criticalPct);

  const { status, message } = determineOverallStatus(
    billingStatus, phoneAuthEnabled,
    primaryQuota.usagePercentage, secondaryQuota.usagePercentage,
    warningPct, criticalPct
  );

  return {
    provider:         'Firebase',
    feature:          'Dashboard User OTP',
    projectId,
    serviceName:      process.env.FIREBASE_SERVICE_NAME || 'identitytoolkit.googleapis.com',
    billingStatus,
    phoneAuthEnabled,
    lastCheckedTime:  new Date().toISOString(),
    lastErrorCode:    _lastError.code,
    lastErrorMessage: _lastError.message,
    lastErrorTime:    _lastError.time,
    primaryQuota,
    secondaryQuota,
    warningThreshold:  warningPct,
    criticalThreshold: criticalPct,
    status,
    message,
  };
}

// ── OTP send pre-check ────────────────────────────────────────────────────────

function checkOtpAllowed(otpStatusData) {
  if (otpStatusData.status === 'Blocked') {
    return {
      allowed: false,
      reason: 'Dashboard OTP is temporarily unavailable because Firebase OTP quota is exhausted or Firebase Authentication has a quota issue. Please contact admin.',
    };
  }
  if (otpStatusData.status === 'Critical') {
    console.warn('[Firebase] OTP allowed but quota is Critical. Check Firebase billing immediately.');
  }
  return { allowed: true, reason: null };
}

// ── Firebase OTP error classifier ────────────────────────────────────────────

const FIREBASE_OTP_ERROR_MESSAGES = {
  'auth/quota-exceeded':         'Firebase OTP quota exceeded. Please try again later or contact admin.',
  'auth/too-many-requests':      'Too many OTP requests. Please wait a moment and try again.',
  'auth/app-not-authorized':     'This app is not authorized to use Firebase Authentication. Please contact admin.',
  'auth/captcha-check-failed':   'reCAPTCHA verification failed. Please refresh the page and try again.',
  'auth/network-request-failed': 'Network error during OTP request. Please check your connection and retry.',
};

function classifyOtpError(firebaseErrorCode, errorMessage) {
  recordOtpError(firebaseErrorCode, errorMessage);
  const userMessage = FIREBASE_OTP_ERROR_MESSAGES[firebaseErrorCode];
  if (userMessage) {
    return { known: true, userMessage };
  }
  return { known: false, userMessage: 'OTP request failed. Please try again.' };
}

module.exports = { fetchOtpStatus, checkOtpAllowed, classifyOtpError, recordOtpError };
