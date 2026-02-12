import nodemailer from 'nodemailer';
import * as fs from 'fs';
import * as path from 'path';

interface EmailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  to: string[];
}

interface TestSummary {
  totalSuites: number;
  successfulSuites: number;
  failedSuites: number;
  totalDuration: string;
  timestamp: string;
  failedTests?: Array<{
    repository: string;
    error?: string;
  }>;
}

export async function sendTestReport(
  dashboardPath: string,
  summary: TestSummary,
  config: EmailConfig
): Promise<void> {
  try {
    console.log('📧 Preparing to send email report...');

    // Create transporter for Zoho Mail
    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure, // true for 465, false for other ports
      auth: {
        user: config.user,
        pass: config.pass,
      },
    });

    // Verify connection
    await transporter.verify();
    console.log('✅ Email server connection verified');

    // Read the dashboard HTML file
    const dashboardHtml = fs.readFileSync(dashboardPath, 'utf-8');

    // Create email subject based on test results
    const status = summary.failedSuites > 0 ? '❌ FAILED' : '✅ PASSED';
    const subject = `${status} - AdHash Test Report - ${summary.timestamp}`;

    // Create email body
    const emailBody = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 30px;
            border-radius: 10px;
            text-align: center;
            margin-bottom: 30px;
        }
        .summary {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 15px;
            margin-bottom: 30px;
        }
        .summary-card {
            background: #f8f9fa;
            padding: 20px;
            border-radius: 10px;
            text-align: center;
            border-left: 4px solid #667eea;
        }
        .summary-card.success {
            border-left-color: #10b981;
        }
        .summary-card.failed {
            border-left-color: #ef4444;
        }
        .summary-card .value {
            font-size: 32px;
            font-weight: bold;
            margin-bottom: 5px;
        }
        .summary-card .label {
            font-size: 14px;
            color: #666;
        }
        .info {
            background: #e3f2fd;
            padding: 20px;
            border-radius: 10px;
            margin-bottom: 20px;
        }
        .footer {
            text-align: center;
            color: #666;
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #ddd;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>🎯 AdHash Unified Test Report</h1>
        <p>Comprehensive test results from all repositories</p>
    </div>

    <div class="summary">
        <div class="summary-card success">
            <div class="value">${summary.successfulSuites}</div>
            <div class="label">Successful</div>
        </div>
        <div class="summary-card failed">
            <div class="value">${summary.failedSuites}</div>
            <div class="label">Failed</div>
        </div>
        <div class="summary-card">
            <div class="value">${summary.totalSuites}</div>
            <div class="label">Total Suites</div>
        </div>
        <div class="summary-card">
            <div class="value">${summary.totalDuration}</div>
            <div class="label">Duration</div>
        </div>
    </div>

    <div class="info">
        <h3>📊 Test Suites Executed:</h3>
        <ul>
            <li>📱 <strong>App Status Verification</strong> - Play Store & App Store verification</li>
            <li>🖥️ <strong>Server Health Monitoring</strong> - 22 production servers</li>
            <li>🔒 <strong>SSL Certificate Monitoring</strong> - 25 certificates</li>
            <li>🌐 <strong>API Endpoint Testing</strong> - 41 API endpoints</li>
        </ul>
    </div>

    <div class="info">
        <h3>📎 Attached Report:</h3>
        <p>Please find the detailed unified dashboard HTML report attached to this email. Open the attachment in your browser to view the complete test results with:</p>
        <ul>
            <li>✅ Detailed test counts for each suite</li>
            <li>❌ Failed test/server details</li>
            <li>📊 Interactive charts and metrics</li>
            <li>🔗 Links to individual test reports</li>
        </ul>
    </div>

    ${summary.failedTests && summary.failedTests.length > 0 ? `
    <div class="info" style="background: #ffebee; border-left: 4px solid #ef4444;">
        <h3>❌ Failed Test Suites:</h3>
        <ul>
            ${summary.failedTests.map(test => `
                <li>
                    <strong>${test.repository}</strong>
                    ${test.error ? `<br><span style="color: #666; font-size: 14px;">Error: ${test.error}</span>` : ''}
                </li>
            `).join('')}
        </ul>
    </div>
    ` : ''}

    <div class="footer">
        <p><strong>Ad-Hash Technolabs Pvt Ltd</strong> - Automated Test Monitoring System</p>
        <p>Generated: ${summary.timestamp}</p>
    </div>
</body>
</html>
    `;

    // Send email with attachment
    const info = await transporter.sendMail({
      from: `"AdHash Test Framework" <${config.from}>`,
      to: config.to.join(', '),
      subject: subject,
      html: emailBody,
      attachments: [
        {
          filename: 'AdHash-Unified-Dashboard.html',
          content: dashboardHtml,
          contentType: 'text/html',
        },
      ],
    });

    console.log('✅ Email sent successfully!');
    console.log('📧 Message ID:', info.messageId);
    console.log('📬 Recipients:', config.to.join(', '));
  } catch (error) {
    console.error('❌ Error sending email:', error);
    throw error;
  }
}

