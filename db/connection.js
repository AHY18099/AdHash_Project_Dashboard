'use strict';
const mongoose = require('mongoose');

let isConnected   = false;
let reconnectTimer = null;

async function connectDB() {
    if (isConnected) return;
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI is not set in environment variables');
    try {
        await mongoose.connect(uri, {
            serverSelectionTimeoutMS: 8000,
            socketTimeoutMS: 45000,
            maxPoolSize: 10,
        });
        isConnected = true;
        console.log('[DB] MongoDB connected via mongoose');

        mongoose.connection.on('disconnected', () => {
            isConnected = false;
            console.warn('[DB] Disconnected — scheduling reconnect in 5s');
            if (!reconnectTimer) {
                reconnectTimer = setTimeout(async () => {
                    reconnectTimer = null;
                    try { await connectDB(); }
                    catch (e) { console.error('[DB] Reconnect failed:', e.message); }
                }, 5000);
            }
        });

        mongoose.connection.on('error', err => {
            console.error('[DB] Connection error:', err.message);
        });
    } catch (err) {
        console.error('[DB] MongoDB connection failed:', err.message);
        throw err;
    }
}

// Middleware: ensures DB is connected before any write operation.
// Returns 503 with retry message if DB is unavailable.
async function ensureConnected(req, res, next) {
    if (isConnected) return next();
    try {
        await connectDB();
        next();
    } catch (e) {
        console.error('[DB] ensureConnected failed:', e.message);
        return res.status(503).json({
            error: 'Database temporarily unavailable. Please retry in a few seconds.'
        });
    }
}

module.exports = { connectDB, ensureConnected };
