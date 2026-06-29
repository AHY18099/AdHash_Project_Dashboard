'use strict';

const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth');
const { fetchTavusStatus, recordTavusError } = require('../src/services/tavus.service');

// GET /api/tavus/status
router.get('/status', requireAuth, async (req, res) => {
  try {
    const data = await fetchTavusStatus();
    return res.json({ success: true, data });
  } catch (err) {
    if (err.configError) {
      return res.status(503).json({
        success: false,
        message: err.message,
        fix: 'In Railway → your service → Variables, add: TAVUS_API_KEY.',
      });
    }
    if (err.authError) {
      return res.status(502).json({ success: false, message: err.message });
    }
    console.error('[Tavus] status error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Unable to fetch Tavus status.',
      error: err.message,
    });
  }
});

// POST /api/tavus/error  — called by app when a Tavus API call fails
// Body: { code: "string", message: "..." }
router.post('/error', requireAuth, (req, res) => {
  const { code, message } = req.body || {};
  if (!code) return res.status(400).json({ success: false, message: 'code is required' });
  recordTavusError(code, message);
  return res.json({ success: true });
});

// GET /api/tavus/env-check  — confirms which vars are present (no values exposed)
router.get('/env-check', requireAuth, (req, res) => {
  res.json({
    TAVUS_API_KEY:                !!process.env.TAVUS_API_KEY,
    TAVUS_BASE_URL:               !!process.env.TAVUS_BASE_URL,
    TAVUS_ACCOUNT_USAGE_ENDPOINT: !!process.env.TAVUS_ACCOUNT_USAGE_ENDPOINT,
    TAVUS_BILLING_AUTH_TOKEN:     !!process.env.TAVUS_BILLING_AUTH_TOKEN,
    TAVUS_WARNING_PERCENTAGE:     !!process.env.TAVUS_WARNING_PERCENTAGE,
    TAVUS_CRITICAL_PERCENTAGE:    !!process.env.TAVUS_CRITICAL_PERCENTAGE,
    TAVUS_PLAN_NAME:              !!process.env.TAVUS_PLAN_NAME,
    TAVUS_LIMIT_TYPE:             !!process.env.TAVUS_LIMIT_TYPE,
  });
});

module.exports = router;
