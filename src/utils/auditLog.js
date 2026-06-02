'use strict';
/**
 * src/utils/auditLog.js — Write an audit entry for every data mutation.
 * Failures are swallowed so a log error never breaks the main operation.
 *
 * Usage:
 *   const { auditLog } = require('./src/utils/auditLog');
 *   await auditLog('CREATE', 'smoke_tests', saved.id, req.user.id, req.user.name, null, saved);
 *   await auditLog('UPDATE', 'smoke_tests', id, req.user.id, req.user.name, before, after);
 *   await auditLog('DELETE', 'smoke_tests', id, req.user.id, req.user.name, record, null);
 */

const { connectDB } = require('../db');

async function auditLog(action, collection, recordId, userId, userName, before, after) {
    try {
        const db = await connectDB();
        const { ObjectId } = require('mongodb');
        await db.collection('audit_logs').insertOne({
            id:         new ObjectId().toString(),
            action,     // 'CREATE' | 'UPDATE' | 'DELETE'
            collection,
            recordId:   recordId || null,
            userId:     userId   || null,
            userName:   userName || null,
            before:     before   || null,
            after:      after    || null,
            timestamp:  new Date(),
        });
    } catch (err) {
        console.error('[AuditLog] Failed to write audit entry:', err.message);
    }
}

module.exports = { auditLog };
