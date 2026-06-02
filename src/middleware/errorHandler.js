'use strict';
/**
 * src/middleware/errorHandler.js — Express global error handler + 404 handler.
 * Must be registered LAST in server.js (after all routes).
 */

const { logError } = require('../utils/errorLog');

function errorHandler(err, req, res, next) {
    console.error('[Error]', err.message);
    logError(err, req, 'express-unhandled').catch(() => {});

    if (res.headersSent) return next(err);

    if (err.code === 11000)         return res.status(409).json({ error: 'Duplicate record' });
    if (err.name === 'CastError')   return res.status(400).json({ error: 'Invalid ID format' });

    res.status(500).json({ error: 'Internal server error', message: err.message });
}

function notFound(req, res) {
    res.status(404).json({ error: `Route not found: ${req.method} ${req.url}` });
}

module.exports = { errorHandler, notFound };
