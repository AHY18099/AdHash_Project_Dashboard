'use strict';

const https = require('https');
const http = require('http');

function determineStatus(pct) {
  if (pct >= 100) return { status: 'blocked', message: 'API blocked — atom limit reached. GIF generation disabled.' };
  if (pct >= 90)  return { status: 'critical', message: `Critical: ${pct.toFixed(1)}% of atoms used. Approaching limit.` };
  if (pct >= 75)  return { status: 'warning',  message: `Warning: ${pct.toFixed(1)}% of atoms used.` };
  return { status: 'normal', message: `Healthy: ${pct.toFixed(1)}% of atoms used.` };
}

function mockSubscriptionStatus() {
  const atomsConsumed = 42500;
  const atomsLimit    = 100000;
  const pct           = (atomsConsumed / atomsLimit) * 100;
  const { status, message } = determineStatus(pct);
  return {
    provider: 'ApyHub',
    workspace: process.env.APYHUB_WORKSPACE || 'adhashmobiledevelopers',
    planName: 'Pro (mock)',
    atomsConsumed,
    atomsLimit,
    remainingAtoms: atomsLimit - atomsConsumed,
    usagePercentage: parseFloat(pct.toFixed(2)),
    billingCycleStart: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString(),
    billingCycleEnd:   new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString(),
    storageUsed: 0,
    storageLimit: 0,
    throttling: false,
    apiKeysUsed: 1,
    apiKeysLimit: 5,
    status,
    message,
    isMock: true,
  };
}

function fetchRaw(url, options) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('Request timed out')); });
    req.end();
  });
}

async function fetchSubscriptionStatus() {
  const endpoint = process.env.APYHUB_SUBSCRIPTION_USAGE_ENDPOINT;
  const authToken = process.env.APYHUB_AUTH_TOKEN;

  if (!endpoint || !authToken) {
    return mockSubscriptionStatus();
  }

  const url = new URL(endpoint);
  const options = {
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: 'GET',
    headers: {
      'apy-token': authToken,
      'Content-Type': 'application/json',
    },
  };

  const { statusCode, body } = await fetchRaw(endpoint, options);

  if (statusCode !== 200) {
    throw new Error(`ApyHub API returned ${statusCode}`);
  }

  const raw = JSON.parse(body);

  // Normalize ApyHub response shape
  const atomsConsumed = raw.atoms_consumed ?? raw.atomsConsumed ?? 0;
  const atomsLimit    = raw.atoms_limit    ?? raw.atomsLimit    ?? 1;
  const pct           = (atomsConsumed / atomsLimit) * 100;
  const { status, message } = determineStatus(pct);

  return {
    provider: 'ApyHub',
    workspace: process.env.APYHUB_WORKSPACE || raw.workspace || 'adhashmobiledevelopers',
    planName: raw.plan_name ?? raw.planName ?? 'Unknown',
    atomsConsumed,
    atomsLimit,
    remainingAtoms: atomsLimit - atomsConsumed,
    usagePercentage: parseFloat(pct.toFixed(2)),
    billingCycleStart: raw.billing_cycle_start ?? raw.billingCycleStart ?? null,
    billingCycleEnd:   raw.billing_cycle_end   ?? raw.billingCycleEnd   ?? null,
    storageUsed:  raw.storage_used  ?? raw.storageUsed  ?? 0,
    storageLimit: raw.storage_limit ?? raw.storageLimit ?? 0,
    throttling: raw.throttling ?? false,
    apiKeysUsed:  raw.api_keys_used  ?? raw.apiKeysUsed  ?? 0,
    apiKeysLimit: raw.api_keys_limit ?? raw.apiKeysLimit ?? 0,
    status,
    message,
    isMock: false,
  };
}

function checkGifGenerationAllowed(subscriptionData) {
  return {
    allowed: subscriptionData.status !== 'blocked',
    reason: subscriptionData.status === 'blocked'
      ? 'GIF generation disabled: ApyHub atom limit reached. Please upgrade your plan.'
      : null,
  };
}

module.exports = { fetchSubscriptionStatus, checkGifGenerationAllowed, determineStatus };
