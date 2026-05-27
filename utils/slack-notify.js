/**
 * Slack notification utility — uses Slack Web API (chat.postMessage) via axios.
 * No extra npm package needed; axios is already a dependency.
 */
const axios = require('axios');

const SLACK_API = 'https://slack.googleapis.com/slack/v1/chat.postMessage';
const SLACK_POST = 'https://slack.com/api/chat.postMessage';

// Color per notification type
const TYPE_COLORS = {
    teamtask:     '#6366f1',
    release_today:'#10b981',
    release_next: '#3b82f6',
    feedback_req: '#f59e0b',
    feedback_bug: '#ef4444',
};

const TYPE_EMOJIS = {
    teamtask:     ':clipboard:',
    release_today:':rocket:',
    release_next: ':calendar:',
    feedback_req: ':memo:',
    feedback_bug: ':bug:',
};

const TYPE_LABELS = {
    teamtask:     'Team Task Assigned',
    release_today:"Today's Release",
    release_next: 'Next Release',
    feedback_req: 'New Client Requirement',
    feedback_bug: 'New Bug Reported',
};

/**
 * Send a Slack notification.
 * @param {object} opts
 * @param {string} opts.type         - one of teamtask|release_today|release_next|feedback_req|feedback_bug
 * @param {string} opts.projectName  - project display name
 * @param {string} opts.assignedBy   - who assigned/reported
 * @param {Array}  opts.details      - [{label, value}, ...]
 * @param {string} opts.dashboardUrl - link to dashboard
 */
async function sendSlackNotification({ type, projectName, assignedBy, details, dashboardUrl }) {
    const token   = process.env.SLACK_BOT_TOKEN;
    // Slack API requires channel name WITHOUT the '#' prefix, or a channel ID.
    // Strip leading '#' if present.
    const rawChannel = process.env.SLACK_CHANNEL || 'testing-team';
    const channel = rawChannel.startsWith('#') ? rawChannel.slice(1) : rawChannel;

    if (!token) throw new Error('SLACK_BOT_TOKEN not configured');
    console.log(`[slack] posting to channel: "${channel}" token starts with: ${token.slice(0,12)}...`);

    const color     = TYPE_COLORS[type]  || '#6366f1';
    const emoji     = TYPE_EMOJIS[type]  || ':bell:';
    const typeLabel = TYPE_LABELS[type]  || 'Dashboard Notification';
    const dashUrl   = dashboardUrl || 'https://adhashprojectdashboard-production.up.railway.app/';

    const now = new Date();
    const dateTimeStr = now.toLocaleString('en-IN', {
        weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });

    // Build fields from details array (max 10 for readability)
    const fields = (details || []).slice(0, 10).map(d => ({
        type: 'mrkdwn',
        text: `*${d.label}*\n${d.value || '—'}`
    }));

    // Split fields into pairs for 2-column layout
    const fieldChunks = [];
    for (let i = 0; i < fields.length; i += 2) {
        fieldChunks.push(fields.slice(i, i + 2));
    }

    const blocks = [
        // Header
        {
            type: 'header',
            text: { type: 'plain_text', text: `${emoji} ${typeLabel}`, emoji: true }
        },
        // Project + assigned by context
        {
            type: 'context',
            elements: [
                { type: 'mrkdwn', text: projectName ? `📁 *${projectName}*` : '*AdHash QA Dashboard*' },
                { type: 'mrkdwn', text: `👤 Assigned by *${assignedBy || '—'}*` },
                { type: 'mrkdwn', text: `🕐 ${dateTimeStr}` }
            ]
        },
        { type: 'divider' },
        // Detail fields in 2-column chunks
        ...fieldChunks.map(chunk => ({
            type: 'section',
            fields: chunk
        })),
        { type: 'divider' },
        // CTA button
        {
            type: 'actions',
            elements: [{
                type: 'button',
                text: { type: 'plain_text', text: '🚀 Open Dashboard', emoji: true },
                url: dashUrl,
                style: 'primary'
            }]
        }
    ];

    // Also build a plain-text fallback attachment (for Slack clients that don't render blocks)
    const fallbackText = `${emoji} *${typeLabel}* — ${projectName || 'AdHash Dashboard'} | by ${assignedBy || '—'}`;

    const payload = {
        channel,
        text: fallbackText,
        attachments: [{
            color,
            blocks
        }]
    };

    const response = await axios.post(SLACK_POST, payload, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        timeout: 10000
    });

    if (!response.data.ok) {
        console.error(`[slack] API response (not ok):`, JSON.stringify(response.data));
        throw new Error(`Slack API error: ${response.data.error}`);
    }
    console.log(`[slack] ✅ message posted to #${channel}`);

    return response.data;
}

module.exports = { sendSlackNotification };
