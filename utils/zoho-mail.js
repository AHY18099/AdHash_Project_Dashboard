/**
 * Zoho Mail utility — uses Zoho Mail REST API over HTTPS (port 443).
 * SMTP is blocked on Railway; this HTTP approach always works.
 *
 * OAuth2 flow: refresh_token → access_token (1h TTL) → send mail.
 * Credentials stored as env vars (set as Railway variables).
 */
const axios = require('axios');

// Zoho OAuth2 + Mail API endpoints (India DC — zoho.com works for .in accounts too)
const TOKEN_URL    = 'https://accounts.zoho.com/oauth/v2/token';
const MAIL_API     = 'https://mail.zoho.com/api/accounts';

// In-memory access token cache (refreshed when expired)
let _cachedToken      = null;
let _tokenExpiresAt   = 0;

async function getAccessToken() {
    const now = Date.now();
    // Reuse cached token if still valid (with 60s safety margin)
    if (_cachedToken && now < _tokenExpiresAt - 60000) {
        return _cachedToken;
    }

    const clientId     = process.env.ZOHO_CLIENT_ID;
    const clientSecret = process.env.ZOHO_CLIENT_SECRET;
    const refreshToken = process.env.ZOHO_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !refreshToken) {
        throw new Error('Zoho OAuth env vars missing: ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN');
    }

    console.log('[zoho-mail] refreshing access token...');
    const resp = await axios.post(TOKEN_URL, new URLSearchParams({
        grant_type:    'refresh_token',
        client_id:     clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
    }), { timeout: 15000 });

    if (!resp.data.access_token) {
        throw new Error(`Zoho token refresh failed: ${JSON.stringify(resp.data)}`);
    }

    _cachedToken    = resp.data.access_token;
    _tokenExpiresAt = now + (resp.data.expires_in || 3600) * 1000;
    console.log('[zoho-mail] ✅ access token refreshed');
    return _cachedToken;
}

async function sendZohoMail({ subject, html, to, from, cc }) {
    const accountId = process.env.ZOHO_ACCOUNT_ID;
    if (!accountId) throw new Error('ZOHO_ACCOUNT_ID env var not set');

    const accessToken = await getAccessToken();

    const fromAddr = from || process.env.ZOHO_MAIL_FROM || 'thenilavan@adhashtech.com';
    const toAddr   = to   || process.env.ZOHO_MAIL_TO   || 'qateam@adhashtech.com';
    const ccAddr   = cc   || process.env.ZOHO_MAIL_CC   || '';

    const payload = {
        fromAddress: fromAddr,
        toAddress:   toAddr,
        subject,
        content:     html,
        mailFormat:  'html',
    };
    if (ccAddr) payload.ccAddress = ccAddr;

    console.log(`[zoho-mail] sending via REST API → to:${toAddr} cc:${ccAddr}`);

    const resp = await axios.post(
        `${MAIL_API}/${accountId}/messages`,
        payload,
        {
            headers: {
                Authorization:  `Zoho-oauthtoken ${accessToken}`,
                'Content-Type': 'application/json',
            },
            timeout: 20000,
        }
    );

    if (resp.data?.status?.code !== 200) {
        throw new Error(`Zoho Mail API error: ${JSON.stringify(resp.data?.status || resp.data)}`);
    }

    console.log(`[zoho-mail] ✅ email sent → messageId:${resp.data?.data?.messageId}`);
    return resp.data;
}

module.exports = { sendZohoMail };
