'use strict';
const mongoose = require('mongoose');

let isConnected = false;

async function connectDB() {
    if (isConnected) return;
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI is not set in environment variables');
    try {
        await mongoose.connect(uri, {
            serverSelectionTimeoutMS: 8000,
            socketTimeoutMS: 45000,
        });
        isConnected = true;
        console.log('[DB] MongoDB connected via mongoose');
        mongoose.connection.on('disconnected', () => {
            isConnected = false;
            console.warn('[DB] MongoDB disconnected — will reconnect on next request');
        });
        mongoose.connection.on('error', (err) => {
            console.error('[DB] MongoDB error:', err.message);
        });
    } catch (err) {
        console.error('[DB] MongoDB connection failed:', err.message);
        throw err;
    }
}

module.exports = { connectDB };
