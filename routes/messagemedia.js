'use strict';

const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth');
const { fetchMessageMediaStatus, recordSmsError } = require('../src/services/messagemedia.service');

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

// POST /api/messagemedia/sms-error  — called by app when an SMS send fails
// Body: { code: "4xx", message: "..." }
router.post('/sms-error', requireAuth, (req, res) => {
  const { code, message } = req.body || {};
  if (!code) return res.status(400).json({ success: false, message: 'code is required' });
  recordSmsError(code, message);
  return res.json({ success: true });
});

// GET /api/messagemedia/env-check  — confirms which vars are present (no values exposed)
router.get('/env-check', requireAuth, (req, res) => {
  res.json({
    MESSAGEMEDIA_API_KEY:                  !!process.env.MESSAGEMEDIA_API_KEY,
    MESSAGEMEDIA_API_SECRET:               !!process.env.MESSAGEMEDIA_API_SECRET,
    MESSAGEMEDIA_SOURCE_NUMBER:            !!process.env.MESSAGEMEDIA_SOURCE_NUMBER,
    MESSAGEMEDIA_CREDIT_BALANCE_ENDPOINT:  !!process.env.MESSAGEMEDIA_CREDIT_BALANCE_ENDPOINT,
    MESSAGEMEDIA_WARNING_CREDITS:          !!process.env.MESSAGEMEDIA_WARNING_CREDITS,
    MESSAGEMEDIA_CRITICAL_CREDITS:         !!process.env.MESSAGEMEDIA_CRITICAL_CREDITS,
  });
});

module.exports = router;
