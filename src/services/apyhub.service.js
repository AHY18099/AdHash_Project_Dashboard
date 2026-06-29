'use strict';

const https = require('https');
const http = require('http');

// ── In-process token bucket for GIF generation throttle ──────────────────────
// Refills at `ratePerSec` tokens/sec (default 5, updated from live subscription).
// checkGifGenerationAllowed() consumes one token; excess requests are rejected.
const _throttle = {
  ratePerSec: 5,       // updated from data.limits.throttling each status fetch
  tokens: 5,           // start full
  lastRefill: Date.now(),

  updateRate(ratePerSec) {
    if (typeof ratePerSec === 'number' && ratePerSec > 0) {
      this.ratePerSec = ratePerSec;
    }
  },

  tryConsume() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;        // seconds since last refill
    this.tokens = Math.min(this.ratePerSec, this.tokens + elapsed * this.ratePerSec);
    this.lastRefill = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;   // allowed
    }
    return false;    // throttled
  },
};

// ── Status helpers ────────────────────────────────────────────────────────────

function determineStatus(usagePercentage, overdue, subscriptionStatus) {
  if (overdue) {
    return { status: 'Blocked', message: 'ApyHub subscription is overdue. Please renew or complete payment.' };
  }
  if (subscriptionStatus === 'Expired') {
    return { status: 'Blocked', message: 'ApyHub billing cycle has expired. Please renew your subscription.' };
  }
  if (usagePercentage >= 100) {
    return { status: 'Blocked', message: 'ApyHub atoms are fully consumed. Please renew or purchase atoms.' };
  }
  if (usagePercentage >= 90) {
    return { status: 'Critical', message: 'ApyHub atoms crossed 90%. Please recharge immediately.' };
  }
  if (usagePercentage >= 75) {
    return { status: 'Warning', message: 'ApyHub atoms crossed 75%. Please plan recharge.' };
  }
  return { status: 'Normal', message: 'ApyHub usage is normal.' };
}

function determineSubscriptionStatus(billingCycleEnd) {
  if (!billingCycleEnd) return { subscriptionStatus: 'Unknown', daysUntilExpiry: null };
  const now = Date.now();
  const end = new Date(billingCycleEnd).getTime();
  const daysUntilExpiry = Math.ceil((end - now) / (1000 * 60 * 60 * 24));
  let subscriptionStatus;
  if (daysUntilExpiry <= 0)  subscriptionStatus = 'Expired';
  else if (daysUntilExpiry <= 3) subscriptionStatus = 'Expiring Soon';
  else subscriptionStatus = 'Active';
  return { subscriptionStatus, daysUntilExpiry };
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function fetchRaw(endpoint, authToken) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
    };
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('Request timed out after 10s')); });
    req.end();
  });
}

// ── Main fetch ────────────────────────────────────────────────────────────────

async function fetchSubscriptionStatus() {
  const endpoint  = process.env.APYHUB_SUBSCRIPTION_USAGE_ENDPOINT;
  const authToken = process.env.APYHUB_AUTH_TOKEN;

  if (!endpoint) {
    const err = new Error('APYHUB_SUBSCRIPTION_USAGE_ENDPOINT is not configured.');
    err.configError = true;
    throw err;
  }
  if (!authToken) {
    const err = new Error('APYHUB_AUTH_TOKEN is not configured.');
    err.configError = true;
    throw err;
  }

  const { statusCode, body } = await fetchRaw(endpoint, authToken);

  if (statusCode === 401 || statusCode === 403) {
    const err = new Error('ApyHub authorization failed. Please verify APYHUB_AUTH_TOKEN.');
    err.authError = true;
    throw err;
  }
  if (statusCode !== 200) {
    throw new Error(`Unable to fetch ApyHub subscription usage. (HTTP ${statusCode})`);
  }

  let raw;
  try {
    raw = JSON.parse(body);
  } catch (parseErr) {
    throw new Error(`ApyHub returned invalid JSON: ${parseErr.message}`);
  }

  const d = raw.data;

  const atomsConsumed   = d.usage?.success   ?? 0;
  const atomsLimit      = d.limits?.coins    ?? 1;
  const usagePercentage = Number(((atomsConsumed / atomsLimit) * 100).toFixed(2));
  const remainingAtoms  = atomsLimit - atomsConsumed;

  const throttleLimit = d.limits?.throttling ?? 5;

  // Keep the in-process bucket in sync with the live plan limit
  _throttle.updateRate(throttleLimit);

  const { subscriptionStatus, daysUntilExpiry } = determineSubscriptionStatus(d.cycle_end);
  const { status, message } = determineStatus(usagePercentage, !!d.overdue, subscriptionStatus);

  return {
    provider: 'ApyHub',
    workspace: process.env.APYHUB_WORKSPACE || 'adhashmobiledevelopers',
    planName: d.plan ?? 'Unknown',
    atomsConsumed,
    atomsLimit,
    remainingAtoms,
    usagePercentage,
    billingCycleStart: d.cycle_start ?? null,
    billingCycleEnd:   d.cycle_end   ?? null,
    daysUntilExpiry,
    subscriptionStatus,
    prePurchasedAtomsBalance: d.pre_purchase_atom_details?.pre_purchased_atoms_balance ?? 0,
    totalPrePurchasedAtoms:   d.pre_purchase_atom_details?.total_pre_purchased_atoms   ?? 0,
    throttleLimit,
    throttling:   `${throttleLimit}/sec`,
    apiKeysUsed:   d.keys             ?? 0,
    apiKeysLimit:  d.limits?.api_keys ?? 0,
    usersUsed:     d.users            ?? 0,
    usersLimit:    d.limits?.users    ?? 0,
    aiAtomsConsumed: d.ai_usage?.ai_usage_atoms ?? 0,
    aiAtomsLimit:    d.limits?.ai_coins         ?? 0,
    aiCallsMade:     d.ai_usage?.ai_calls_made  ?? 0,
    approachingLimits: d.approaching_limits ?? false,
    overdue: d.overdue ?? false,
    status,
    message,
  };
}

// ── GIF pre-check ─────────────────────────────────────────────────────────────
// Call this before every GIF generation request. It:
//   1. Blocks if subscription is Blocked (overdue, expired, or atoms exhausted).
//   2. Warns (but allows) on Critical or approaching_limits.
//   3. Enforces the plan throttle limit (token bucket, rate from live data).

function checkGifGenerationAllowed(subscriptionData) {
  // Hard block conditions
  if (subscriptionData.status === 'Blocked') {
    return {
      allowed: false,
      throttled: false,
      reason: 'GIF generation is temporarily unavailable because ApyHub credits are exhausted or subscription is overdue. Please contact admin to recharge the ApyHub account.',
    };
  }

  if (subscriptionData.subscriptionStatus === 'Expired') {
    return {
      allowed: false,
      throttled: false,
      reason: 'GIF generation is unavailable because the ApyHub billing cycle has expired. Please renew the subscription.',
    };
  }

  // Soft warnings — log but do not block
  if (subscriptionData.status === 'Critical') {
    console.warn('[ApyHub] GIF generation allowed but atom usage is Critical (>=90%). Recharge soon.');
  }
  if (subscriptionData.approachingLimits) {
    console.warn('[ApyHub] GIF generation allowed but subscription is approaching its limits.');
  }
  if (subscriptionData.subscriptionStatus === 'Expiring Soon') {
    console.warn(`[ApyHub] Billing cycle expires in ${subscriptionData.daysUntilExpiry} day(s). Plan renewal.`);
  }

  // Throttle check — token bucket enforces plan's requests/sec limit
  if (!_throttle.tryConsume()) {
    const limit = _throttle.ratePerSec;
    return {
      allowed: false,
      throttled: true,
      reason: `GIF generation throttled: ApyHub plan allows ${limit} request${limit === 1 ? '' : 's'} per second. Please retry in a moment.`,
    };
  }

  return { allowed: true, throttled: false, reason: null };
}

module.exports = { fetchSubscriptionStatus, checkGifGenerationAllowed, determineStatus };
