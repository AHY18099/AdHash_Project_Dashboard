'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { fetchSubscriptionStatus } = require('../src/services/apyhub.service');

// GET /api/apyhub/subscription-status
router.get('/subscription-status', requireAuth, async (req, res) => {
  try {
    const data = await fetchSubscriptionStatus();
    return res.json({ success: true, data });
  } catch (err) {
    if (err.configError) {
      return res.status(503).json({
        success: false,
        message: err.message,
        fix: 'In Railway → your service → Variables, add the missing env var directly or reference it as ${{VAR_NAME}} from Shared Variables.',
      });
    }
    if (err.authError) {
      return res.status(502).json({ success: false, message: err.message });
    }
    console.error('[ApyHub] subscription-status error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Unable to fetch ApyHub subscription usage.',
      error: err.message,
    });
  }
});

// GET /api/apyhub/env-check  — confirms which vars are present (no values exposed)
router.get('/env-check', requireAuth, (req, res) => {
  res.json({
    APYHUB_SUBSCRIPTION_USAGE_ENDPOINT: !!process.env.APYHUB_SUBSCRIPTION_USAGE_ENDPOINT,
    APYHUB_AUTH_TOKEN:                  !!process.env.APYHUB_AUTH_TOKEN,
    APYHUB_WORKSPACE:                   !!process.env.APYHUB_WORKSPACE,
  });
});

module.exports = router;
