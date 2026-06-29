'use strict';

const https = require('https');

// ── Google OAuth2 — service account JWT → access token ───────────────────────

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function signJwt(header, payload, privateKey) {
  const crypto = require('crypto');
  const data = `${base64url(Buffer.from(JSON.stringify(header)))}.${base64url(Buffer.from(JSON.stringify(payload)))}`;
  const sig = crypto.createSign('RSA-SHA256').update(data).sign(privateKey, 'base64');
  return `${data}.${base64url(Buffer.from(sig, 'base64'))}`;
}

async function getGoogleAccessToken(serviceAccountJson, scopes) {
  const sa = typeof serviceAccountJson === 'string' ? JSON.parse(serviceAccountJson) : serviceAccountJson;
  const now = Math.floor(Date.now() / 1000);
  const jwt = signJwt(
    { alg: 'RS256', typ: 'JWT' },
    { iss: sa.client_email, scope: scopes.join(' '), aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 },
    sa.private_key
  );

  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  const { statusCode, responseBody } = await httpsPost('oauth2.googleapis.com', '/token', body, {
    'Content-Type': 'application/x-www-form-urlencoded',
  });

  if (statusCode !== 200) {
    throw new Error(`Google OAuth2 token exchange failed (HTTP ${statusCode}): ${responseBody}`);
  }
  const parsed = JSON.parse(responseBody);
  return parsed.access_token;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpsGet(hostname, path, token) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname,
      path,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('Request timed out')); });
    req.end();
  });
}

function httpsPost(hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname,
      path,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(options, (res) => {
      let responseBody = '';
      res.on('data', (c) => { responseBody += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, responseBody }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('Request timed out')); });
    req.write(body);
    req.end();
  });
}

// ── Status logic ──────────────────────────────────────────────────────────────

function determineOtpStatus(usagePercentage, warningPct, criticalPct) {
  if (usagePercentage >= 100) {
    return { status: 'Blocked', message: 'Firebase OTP verification quota is fully consumed.' };
  }
  if (usagePercentage >= criticalPct) {
    return { status: 'Critical', message: `Firebase OTP verification quota crossed ${criticalPct}%. Please check Firebase quota/billing immediately.` };
  }
  if (usagePercentage >= warningPct) {
    return { status: 'Warning', message: `Firebase OTP verification quota crossed ${warningPct}%. Please monitor usage.` };
  }
  return { status: 'Normal', message: 'Firebase OTP usage is normal.' };
}

// ── Quota limit via Service Usage API ────────────────────────────────────────
// Returns the daily limit for "Send Verification Code per day" quota.

async function fetchQuotaLimit(projectNumber, token) {
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

  const raw = JSON.parse(body);
  const metrics = raw.metrics || [];
  const targetNames = ['send verification code', 'send_verification_code', 'verificationcodes', 'daily'];

  for (const metric of metrics) {
    const displayName = (metric.displayName || '').toLowerCase();
    const metricName  = (metric.metric || '').toLowerCase();
    const isMatch = targetNames.some(t => displayName.includes(t) || metricName.includes(t));
    if (!isMatch) continue;

    for (const group of (metric.consumerQuotaLimits || [])) {
      for (const bucket of (group.quotaBuckets || [])) {
        const limit = bucket.effectiveLimit;
        if (typeof limit === 'number' && limit > 0) return limit;
        // effectiveLimit may be a string (int64 in JSON)
        const parsed = parseInt(limit, 10);
        if (!isNaN(parsed) && parsed > 0) return parsed;
      }
    }
  }

  // Fallback: Firebase default for Phone Auth is 10,000/day for most projects
  console.warn('[Firebase] Could not find Send Verification Code quota in Service Usage API — using default 10000');
  return 10000;
}

// ── Current usage via Cloud Monitoring API ────────────────────────────────────
// Tries allocation/usage first, falls back to rate/net_usage.

async function fetchOtpUsage(projectId, token) {
  const endTime   = new Date().toISOString();
  const startTime = new Date(Date.now() - 86400000).toISOString(); // last 24h

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

    const raw = JSON.parse(body);
    const series = raw.timeSeries || [];

    for (const ts of series) {
      const labels = ts.metric?.labels || {};
      const resource = ts.resource?.labels || {};
      const quotaMetric = (labels.quota_metric || labels.metric_name || resource.quota_metric || '').toLowerCase();
      const service     = (resource.service || resource.monitored_resource || '').toLowerCase();

      const isOtpQuota = quotaMetric.includes('verifyphone') ||
                         quotaMetric.includes('verificationcode') ||
                         quotaMetric.includes('send_verification') ||
                         quotaMetric.includes('identitytoolkit');
      const isService  = service.includes('identitytoolkit') || service === '';

      if (!isOtpQuota && !isService) continue;

      const points = ts.points || [];
      if (points.length === 0) continue;
      const latest = points[0]?.value?.int64Value ?? points[0]?.value?.doubleValue ?? 0;
      const usage  = parseInt(String(latest), 10);
      if (!isNaN(usage)) return usage;
    }
  }

  // No usage data found — quota not yet consumed today or API returned empty
  return 0;
}

// ── Main export ───────────────────────────────────────────────────────────────

async function fetchOtpStatus() {
  const saJson         = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  const projectId      = process.env.FIREBASE_PROJECT_ID;
  const projectNumber  = process.env.FIREBASE_PROJECT_NUMBER;
  const warningPct     = parseInt(process.env.FIREBASE_OTP_WARNING_PERCENTAGE  || '75', 10);
  const criticalPct    = parseInt(process.env.FIREBASE_OTP_CRITICAL_PERCENTAGE || '90', 10);

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

  const [dailyLimit, currentUsage] = await Promise.all([
    fetchQuotaLimit(projectNumber, token),
    fetchOtpUsage(projectId, token),
  ]);

  const remainingQuota  = Math.max(0, dailyLimit - currentUsage);
  const usagePercentage = Number(((currentUsage / dailyLimit) * 100).toFixed(2));
  const { status, message } = determineOtpStatus(usagePercentage, warningPct, criticalPct);

  return {
    provider:       'Firebase',
    feature:        'Dashboard User OTP',
    projectId,
    serviceName:    process.env.FIREBASE_SERVICE_NAME || 'identitytoolkit.googleapis.com',
    quotaName:      process.env.FIREBASE_OTP_QUOTA_NAME || 'Send Verification Code per day',
    currentUsage,
    dailyLimit,
    remainingQuota,
    usagePercentage,
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
    console.warn('[Firebase] OTP allowed but quota is Critical (>=90%). Check Firebase billing immediately.');
  }
  return { allowed: true, reason: null };
}

// ── Firebase OTP error classifier ────────────────────────────────────────────

const FIREBASE_OTP_ERROR_MESSAGES = {
  'auth/quota-exceeded':        'Firebase OTP quota exceeded. Please try again later or contact admin.',
  'auth/too-many-requests':     'Too many OTP requests. Please wait a moment and try again.',
  'auth/app-not-authorized':    'This app is not authorized to use Firebase Authentication. Please contact admin.',
  'auth/captcha-check-failed':  'reCAPTCHA verification failed. Please refresh the page and try again.',
  'auth/network-request-failed':'Network error during OTP request. Please check your connection and retry.',
};

function classifyOtpError(firebaseErrorCode) {
  const userMessage = FIREBASE_OTP_ERROR_MESSAGES[firebaseErrorCode];
  if (userMessage) {
    console.error(`[Firebase OTP Error] ${firebaseErrorCode}`);
    return { known: true, userMessage };
  }
  return { known: false, userMessage: 'OTP request failed. Please try again.' };
}

module.exports = { fetchOtpStatus, checkOtpAllowed, classifyOtpError };
