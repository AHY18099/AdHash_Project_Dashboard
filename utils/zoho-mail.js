const nodemailer = require('nodemailer');

function getTransportConfigs() {
    const envHost = process.env.ZOHO_MAIL_HOST;
    const port = Number(process.env.ZOHO_MAIL_PORT || 465);
    const secure = process.env.ZOHO_MAIL_SECURE
        ? process.env.ZOHO_MAIL_SECURE === 'true'
        : port === 465;

    if (envHost) {
        return [{ host: envHost, port, secure }];
    }

    // Fallback across common Zoho SMTP endpoints for region/account differences.
    return [
        { host: 'smtp.zoho.in', port: 465, secure: true },
        { host: 'smtp.zoho.com', port: 465, secure: true }
    ];
}

function getZohoTransport(config) {
    return nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        connectionTimeout: 10000,   // 10s to connect
        greetingTimeout:   8000,    // 8s for SMTP greeting
        socketTimeout:     15000,   // 15s for each socket operation
        auth: {
            user: process.env.ZOHO_MAIL_USER,
            pass: process.env.ZOHO_MAIL_PASS
        }
    });
}

async function sendZohoMail({ subject, html, to, from, cc }) {
    const configs = getTransportConfigs();
    let lastError;

    for (const config of configs) {
        const transporter = getZohoTransport(config);
        try {
            const mailOptions = {
                from: from || process.env.ZOHO_MAIL_FROM,
                to: to || process.env.ZOHO_MAIL_TO,
                subject,
                html
            };
            // CC: use provided cc, or fall back to ZOHO_MAIL_CC env var
            const ccAddr = cc || process.env.ZOHO_MAIL_CC;
            if (ccAddr) mailOptions.cc = ccAddr;

            const info = await transporter.sendMail(mailOptions);
            return info;
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error('Zoho mail send failed on all SMTP endpoints');
}

module.exports = { sendZohoMail };
