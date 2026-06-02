'use strict';
/**
 * src/utils/errorLog.js — Persist server errors to MongoDB error_logs collection.
 * Failures are swallowed so a log error never cascades into another error.
 *
 * Usage:
 *   const { logError } = require('./src/utils/errorLog');
 *   await logError(err, req, 'context string');
 */

const { connectDB } = require('../db');

async function logError(err, req, context) {
    try {
        const db = await connectDB();
        const { ObjectId } = require('mongodb');
        await db.collection('error_logs').insertOne({
            id:        new ObjectId().toString(),
            message:   err && err.message ? err.message : String(err),
            stack:     err && err.stack   ? err.stack   : null,
            context:   context || null,
            url:       req  ? req.url    : null,
            method:    req  ? req.method : null,
            userId:    req  && req.user  ? req.user.id   : null,
            userName:  req  && req.user  ? req.user.name : null,
            timestamp: new Date(),
        });
    } catch (logErr) {
        console.error('[ErrorLog] Failed to write error entry:', logErr.message);
    }
}

module.exports = { logError };
