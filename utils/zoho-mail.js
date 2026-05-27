const nodemailer = require('nodemailer');

function getTransportConfigs() {
    const envHost = process.env.ZOHO_MAIL_HOST;
    const port = Number(process.env.ZOHO_MAIL_PORT || 0); // 0 = use defaults below
    const secureEnv = process.env.ZOHO_MAIL_SECURE;

    if (envHost && port) {
        const secure = secureEnv ? secureEnv === 'true' : port === 465;
        return [{ host: envHost, port, secure }];
    }

    // Railway (and many cloud hosts) block outbound port 465 (SMTPS).
    // Try port 587 (STARTTLS) first — works on most clouds.
    // Then fall back to 465 in case 587 is blocked.
    return [
        // Port 587 STARTTLS — most cloud-friendly
        { host: 'smtp.zoho.in',  port: 587, secure: false },
        { host: 'smtp.zoho.com', port: 587, secure: false },
        // Port 465 SSL — direct SSL, blocked by some clouds
        { host: 'smtp.zoho.in',  port: 465, secure: true  },
        { host: 'smtp.zoho.com', port: 465, secure: true  },
    ];
}

function getZohoTransport(config) {
    const transportOptions = {
        host: config.host,
        port: config.port,
        secure: config.secure,       // false = STARTTLS upgrade, true = direct SSL
        connectionTimeout: 15000,    // 15s to connect
        greetingTimeout:   10000,    // 10s for SMTP greeting
        socketTimeout:     20000,    // 20s for each socket operation
        auth: {
            user: process.env.ZOHO_MAIL_USER,
            pass: process.env.ZOHO_MAIL_PASS
        }
    };
    // For port 587 STARTTLS, require TLS upgrade
    if (!config.secure) {
        transportOptions.requireTLS = true;
        transportOptions.tls = { rejectUnauthorized: false };
    }
    return nodemailer.createTransport(transportOptions);
}

async function sendZohoMail({ subject, html, to, from, cc }) {
    const configs = getTransportConfigs();
    let lastError;

    for (const config of configs) {
        const transporter = getZohoTransport(config);
        try {
            console.log(`[zoho-mail] trying ${config.host}:${config.port} secure=${config.secure}`);
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
            console.log(`[zoho-mail] ✅ sent via ${config.host}:${config.port} → messageId:${info.messageId}`);
            return info;
        } catch (error) {
            console.warn(`[zoho-mail] ❌ ${config.host}:${config.port} failed: ${error.message}`);
            lastError = error;
        }
    }

    throw lastError || new Error('Zoho mail send failed on all SMTP endpoints');
}

module.exports = { sendZohoMail };
