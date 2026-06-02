'use strict';
/**
 * src/config.js — Centralised environment configuration.
 * Import this instead of reading process.env directly in other modules.
 */

function checkEnv() {
    const required = ['MONGODB_URI'];
    const missing  = required.filter(k => !process.env[k]);
    if (missing.length) {
        console.error('❌ Missing required environment variables:', missing.join(', '));
        console.error('   Set them in Railway → Variables and redeploy.');
        process.exit(1);
    }
}

module.exports = {
    checkEnv,
    MONGODB_URI:      process.env.MONGODB_URI,
    MONGODB_DB:       process.env.MONGODB_DB       || 'adhash_qa',
    JWT_SECRET:       process.env.JWT_SECRET        || 'adhash-qa-jwt-secret-change-in-production-2026',
    JWT_EXPIRES:      process.env.JWT_EXPIRES       || '7d',
    PORT:             parseInt(process.env.PORT     || '7777', 10),
    GITHUB_TOKEN:     process.env.GITHUB_TOKEN,
    CACHE_TTL:        30000,              // 30 seconds
    BACKUP_INTERVAL:  6 * 60 * 60 * 1000, // 6 hours
};
