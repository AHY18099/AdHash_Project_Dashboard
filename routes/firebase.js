'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { fetchOtpStatus, recordOtpError } = require('../src/services/firebase.service');

// GET /api/firebase/otp-status
router.get('/otp-status', requireAuth, async (req, res) => {
  try {
    const data = await fetchOtpStatus();
    return res.json({ success: true, data });
  } catch (err) {
    if (err.configError) {
      return res.status(503).json({
        success: false,
        message: err.message,
        fix: 'Add the missing Railway env var. Required: GOOGLE_APPLICATION_CREDENTIALS_JSON, FIREBASE_PROJECT_ID, FIREBASE_PROJECT_NUMBER.',
      });
    }
    if (err.authError) {
      return res.status(502).json({ success: false, message: err.message });
    }
    console.error('[Firebase] otp-status error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Unable to fetch Firebase OTP quota status.',
      error: err.message,
    });
  }
});

// POST /api/firebase/otp-error  — called by app when an OTP send fails
// Body: { code: "auth/quota-exceeded", message: "..." }
router.post('/otp-error', requireAuth, (req, res) => {
  const { code, message } = req.body || {};
  if (!code) return res.status(400).json({ success: false, message: 'code is required' });
  recordOtpError(code, message);
  return res.json({ success: true });
});

// GET /api/firebase/env-check — confirms which vars are present (no values exposed)
router.get('/env-check', requireAuth, (req, res) => {
  res.json({
    GOOGLE_APPLICATION_CREDENTIALS_JSON:  !!process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON,
    FIREBASE_PROJECT_ID:                  !!process.env.FIREBASE_PROJECT_ID,
    FIREBASE_PROJECT_NUMBER:              !!process.env.FIREBASE_PROJECT_NUMBER,
    FIREBASE_SERVICE_NAME:                !!process.env.FIREBASE_SERVICE_NAME,
    FIREBASE_OTP_QUOTA_NAME:              !!process.env.FIREBASE_OTP_QUOTA_NAME,
    FIREBASE_OTP_SECONDARY_QUOTA_NAME:    !!process.env.FIREBASE_OTP_SECONDARY_QUOTA_NAME,
    FIREBASE_OTP_WARNING_PERCENTAGE:      !!process.env.FIREBASE_OTP_WARNING_PERCENTAGE,
    FIREBASE_OTP_CRITICAL_PERCENTAGE:     !!process.env.FIREBASE_OTP_CRITICAL_PERCENTAGE,
    FIREBASE_CHECK_BILLING:               !!process.env.FIREBASE_CHECK_BILLING,
  });
});

module.exports = router;
