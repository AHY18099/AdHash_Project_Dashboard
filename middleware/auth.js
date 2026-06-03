'use strict';
// Auth middleware extracted from server.js — logic unchanged, only moved here.
const AUTH_COOKIE_NAME = 'adhash_auth';

function requireAuth(req, res, next) {
    const cookie   = req.cookies?.[AUTH_COOKIE_NAME];
    const expected = Buffer.from(
        `${process.env.SUPER_ADMIN_EMAIL}:${process.env.SUPER_ADMIN_PASSWORD}`
    ).toString('base64url');
    if (cookie && cookie === expected) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
    return res.redirect('/login.html');
}

module.exports = { requireAuth, AUTH_COOKIE_NAME };
