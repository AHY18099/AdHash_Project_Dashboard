'use strict';

const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth');
const { fetchMessageMediaStatus, recordSmsError, runHealthCheck } = require('../src/services/messagemedia.service');

// Rate-limit health check to once per hour — no DB needed, process-local state
let _lastHealthCheckCall = 0;
const HEALTH_CHECK_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// GET /api/messagemedia/status
router.get('/status', requireAuth, async (req, res) => {
  try {
    const data = await fetchMessageMediaStatus();
    return res.json({ success: true, data });
  } catch (err) {
    if (err.configError) {
      return res.status(503).json({
        success: false,
        message: err.message,
        fix: 'In Railway → your service → Variables, add: MESSAGEMEDIA_API_KEY, MESSAGEMEDIA_API_SECRET, MESSAGEMEDIA_SOURCE_NUMBER.',
      });
    }
    if (err.authError) {
      return res.status(502).json({ success: false, message: err.message });
    }
    console.error('[MessageMedia] status error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Unable to fetch MessageMedia status.',
      error: err.message,
    });
  }
});

// POST /api/messagemedia/health-check  — sends a real test SMS (rate-limited to once/hour)
router.post('/health-check', requireAuth, async (req, res) => {
  const now = Date.now();
  const elapsed = now - _lastHealthCheckCall;
  const remainingSec = Math.ceil((HEALTH_CHECK_COOLDOWN_MS - elapsed) / 1000);

  if (_lastHealthCheckCall > 0 && elapsed < HEALTH_CHECK_COOLDOWN_MS) {
    const remainingMin = Math.ceil(remainingSec / 60);
    return res.status(429).json({
      success: false,
      message: `Health check was already run recently. Please wait ${remainingMin} minute${remainingMin === 1 ? '' : 's'} before running again.`,
      cooldownRemainingSeconds: remainingSec,
    });
  }

  _lastHealthCheckCall = now;

  try {
    const data = await runHealthCheck();
    return res.json({ success: true, data });
  } catch (err) {
    // Reset the cooldown so a config/auth error doesn't lock out the button for an hour
    _lastHealthCheckCall = 0;
    if (err.configError) {
      return res.status(503).json({
        success: false,
        message: err.message,
        fix: 'Add MESSAGEMEDIA_HEALTH_CHECK_TO_NUMBER in Railway service Variables.',
      });
    }
    if (err.authError) {
      return res.status(502).json({ success: false, message: err.message });
    }
    console.error('[MessageMedia] health-check error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Health check failed unexpectedly.',
      error: err.message,
    });
  }
});

// POST /api/messagemedia/sms-error  — called by app when an SMS send fails
router.post('/sms-error', requireAuth, (req, res) => {
  const { code, message } = req.body || {};
  if (!code) return res.status(400).json({ success: false, message: 'code is required' });
  recordSmsError(code, message);
  return res.json({ success: true });
});

// GET /api/messagemedia/env-check  — confirms which vars are present (no values exposed)
router.get('/env-check', requireAuth, (req, res) => {
  res.json({
    MESSAGEMEDIA_API_KEY:                   !!process.env.MESSAGEMEDIA_API_KEY,
    MESSAGEMEDIA_API_SECRET:                !!process.env.MESSAGEMEDIA_API_SECRET,
    MESSAGEMEDIA_SOURCE_NUMBER:             !!process.env.MESSAGEMEDIA_SOURCE_NUMBER,
    MESSAGEMEDIA_CREDIT_BALANCE_ENDPOINT:   !!process.env.MESSAGEMEDIA_CREDIT_BALANCE_ENDPOINT,
    MESSAGEMEDIA_WARNING_CREDITS:           !!process.env.MESSAGEMEDIA_WARNING_CREDITS,
    MESSAGEMEDIA_CRITICAL_CREDITS:          !!process.env.MESSAGEMEDIA_CRITICAL_CREDITS,
    MESSAGEMEDIA_HEALTH_CHECK_TO_NUMBER:    !!process.env.MESSAGEMEDIA_HEALTH_CHECK_TO_NUMBER,
    MESSAGEMEDIA_HEALTH_CHECK_ENABLED:      !!process.env.MESSAGEMEDIA_HEALTH_CHECK_ENABLED,
  });
});

module.exports = router;
