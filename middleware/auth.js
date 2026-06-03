'use strict';
// Auth middleware for route modules — uses the same cookie/JWT logic as server.js isAuthenticated.
// Accepts: super-admin cookie, member cookie, JWT Bearer token.
const AUTH_COOKIE_NAME   = 'adhash_auth';
const MEMBER_COOKIE_PREFIX = 'member:';
const jwt = require('jsonwebtoken');

function _parseCookies(req) {
    const header = req.headers.cookie || '';
    return header.split(';').reduce((acc, part) => {
        const [k, ...v] = part.trim().split('=');
        if (k) acc[k] = decodeURIComponent(v.join('='));
        return acc;
    }, {});
}

function _isAuthenticated(req) {
    // 1. JWT Bearer token
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) {
        try {
            const secret = process.env.JWT_SECRET || 'adhash-qa-jwt-secret-change-in-production-2026';
            if (jwt.verify(auth.slice(7), secret)) return true;
        } catch (_) {}
    }
    // 2. Cookie-based (super-admin or member)
    const cookies = req.cookies || _parseCookies(req);
    const val = cookies[AUTH_COOKIE_NAME] || '';
    // Super-admin cookie
    const email    = process.env.QA_ADMIN_EMAIL    || process.env.SUPER_ADMIN_EMAIL    || '';
    const password = process.env.QA_ADMIN_PASSWORD || process.env.SUPER_ADMIN_PASSWORD || '';
    if (email && password) {
        const expected = Buffer.from(`${email}:${password}`).toString('base64url');
        if (val === expected) return true;
    }
    // Member cookie
    try {
        const decoded = Buffer.from(val, 'base64url').toString('utf8');
        if (decoded.startsWith(MEMBER_COOKIE_PREFIX)) return true;
    } catch (_) {}
    return false;
}

function requireAuth(req, res, next) {
    if (_isAuthenticated(req)) return next();
    // Use originalUrl (full path) — req.path is relative inside a mounted router
    if (req.originalUrl.startsWith('/api/') || req.baseUrl.startsWith('/api/')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.redirect('/login.html');
}

module.exports = { requireAuth, AUTH_COOKIE_NAME };
