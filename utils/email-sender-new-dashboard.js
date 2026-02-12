"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendTestReport = sendTestReport;
var nodemailer_1 = require("nodemailer");
var fs = require("fs");
function sendTestReport(dashboardPath, summary, config) {
    return __awaiter(this, void 0, void 0, function () {
        var transporter, dashboardHtml, status_1, subject, emailBody, info, error_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 3, , 4]);
                    console.log('📧 Preparing to send email report...');
                    transporter = nodemailer_1.default.createTransport({
                        host: config.host,
                        port: config.port,
                        secure: config.secure, // true for 465, false for other ports
                        auth: {
                            user: config.user,
                            pass: config.pass,
                        },
                    });
                    // Verify connection
                    return [4 /*yield*/, transporter.verify()];
                case 1:
                    // Verify connection
                    _a.sent();
                    console.log('✅ Email server connection verified');
                    dashboardHtml = fs.readFileSync(dashboardPath, 'utf-8');
                    status_1 = summary.failedSuites > 0 ? '❌ FAILED' : '✅ PASSED';
                    subject = "".concat(status_1, " - AdHash Test Report - ").concat(summary.timestamp);
                    emailBody = "\n<!DOCTYPE html>\n<html>\n<head>\n    <meta charset=\"UTF-8\">\n    <style>\n        body {\n            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;\n            line-height: 1.6;\n            color: #333;\n            max-width: 800px;\n            margin: 0 auto;\n            padding: 20px;\n        }\n        .header {\n            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);\n            color: white;\n            padding: 30px;\n            border-radius: 10px;\n            text-align: center;\n            margin-bottom: 30px;\n        }\n        .summary {\n            display: grid;\n            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));\n            gap: 15px;\n            margin-bottom: 30px;\n        }\n        .summary-card {\n            background: #f8f9fa;\n            padding: 20px;\n            border-radius: 10px;\n            text-align: center;\n            border-left: 4px solid #667eea;\n        }\n        .summary-card.success {\n            border-left-color: #10b981;\n        }\n        .summary-card.failed {\n            border-left-color: #ef4444;\n        }\n        .summary-card .value {\n            font-size: 32px;\n            font-weight: bold;\n            margin-bottom: 5px;\n        }\n        .summary-card .label {\n            font-size: 14px;\n            color: #666;\n        }\n        .info {\n            background: #e3f2fd;\n            padding: 20px;\n            border-radius: 10px;\n            margin-bottom: 20px;\n        }\n        .footer {\n            text-align: center;\n            color: #666;\n            margin-top: 30px;\n            padding-top: 20px;\n            border-top: 1px solid #ddd;\n        }\n    </style>\n</head>\n<body>\n    <div class=\"header\">\n        <h1>\uD83C\uDFAF AdHash Unified Test Report</h1>\n        <p>Comprehensive test results from all repositories</p>\n    </div>\n\n    <div class=\"summary\">\n        <div class=\"summary-card success\">\n            <div class=\"value\">".concat(summary.successfulSuites, "</div>\n            <div class=\"label\">Successful</div>\n        </div>\n        <div class=\"summary-card failed\">\n            <div class=\"value\">").concat(summary.failedSuites, "</div>\n            <div class=\"label\">Failed</div>\n        </div>\n        <div class=\"summary-card\">\n            <div class=\"value\">").concat(summary.totalSuites, "</div>\n            <div class=\"label\">Total Suites</div>\n        </div>\n        <div class=\"summary-card\">\n            <div class=\"value\">").concat(summary.totalDuration, "</div>\n            <div class=\"label\">Duration</div>\n        </div>\n    </div>\n\n    ").concat(summary.suiteDetails && summary.suiteDetails.length > 0 ? "\n    <div class=\"info\">\n        <h3>\uD83D\uDCCA Test Suites Executed:</h3>\n        ".concat(summary.suiteDetails.map(function (suite) { return "\n            <div style=\"background: ".concat(suite.status === 'success' ? '#f0fdf4' : suite.status === 'error' ? '#fef2f2' : '#fff7ed', ";\n                        padding: 15px;\n                        border-radius: 8px;\n                        margin-bottom: 15px;\n                        border-left: 4px solid ").concat(suite.status === 'success' ? '#10b981' : suite.status === 'error' ? '#ef4444' : '#f59e0b', ";\">\n                <h4 style=\"margin: 0 0 10px 0; color: #333;\">\n                    ").concat(suite.icon, " ").concat(suite.displayName, "\n                    <span style=\"float: right; font-size: 14px; font-weight: normal;\">\n                        ").concat(suite.status === 'success' ? '✅ PASSED' : suite.status === 'error' ? '❌ FAILED' : '⚠️ WARNING', "\n                    </span>\n                </h4>\n                <div style=\"display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 10px; margin-bottom: 10px;\">\n                    <div style=\"text-align: center;\">\n                        <div style=\"font-size: 20px; font-weight: bold; color: #10b981;\">\u2713 ").concat(suite.passed, "</div>\n                        <div style=\"font-size: 12px; color: #666;\">Passed</div>\n                    </div>\n                    <div style=\"text-align: center;\">\n                        <div style=\"font-size: 20px; font-weight: bold; color: #ef4444;\">\u2717 ").concat(suite.failed, "</div>\n                        <div style=\"font-size: 12px; color: #666;\">Failed</div>\n                    </div>\n                    ").concat(suite.warnings !== undefined ? "\n                    <div style=\"text-align: center;\">\n                        <div style=\"font-size: 20px; font-weight: bold; color: #f59e0b;\">\u26A0 ".concat(suite.warnings, "</div>\n                        <div style=\"font-size: 12px; color: #666;\">Warnings</div>\n                    </div>\n                    ") : '', "\n                    <div style=\"text-align: center;\">\n                        <div style=\"font-size: 20px; font-weight: bold; color: #6366f1;\">\u2211 ").concat(suite.total, "</div>\n                        <div style=\"font-size: 12px; color: #666;\">Total</div>\n                    </div>\n                </div>\n                ").concat(suite.error ? "<p style=\"color: #ef4444; font-size: 13px; margin: 5px 0 0 0;\"><strong>Error:</strong> ".concat(suite.error, "</p>") : '', "\n            </div>\n        "); }).join(''), "\n    </div>\n    ") : "\n    <div class=\"info\">\n        <h3>\uD83D\uDCCA Test Suites Executed:</h3>\n        <ul>\n            <li>\uD83D\uDCF1 <strong>App Status Verification</strong> - Play Store & App Store verification</li>\n            <li>\uD83D\uDDA5\uFE0F <strong>Server Health Monitoring</strong> - 22 production servers</li>\n            <li>\uD83D\uDD12 <strong>SSL Certificate Monitoring</strong> - 25 certificates</li>\n            <li>\uD83C\uDF10 <strong>API Endpoint Testing</strong> - 41 API endpoints</li>\n        </ul>\n    </div>\n    ", "\n\n    <div class=\"info\">\n        <h3>\uD83D\uDCCE Attached Report:</h3>\n        <p>Please find the detailed unified dashboard HTML report attached to this email. Open the attachment in your browser to view the complete test results with:</p>\n        <ul>\n            <li>\u2705 Detailed test counts for each suite</li>\n            <li>\u274C Failed test/server details</li>\n            <li>\uD83D\uDCCA Interactive charts and metrics</li>\n            <li>\uD83D\uDD17 Links to individual test reports</li>\n        </ul>\n    </div>\n\n    ").concat(summary.suiteDetails && summary.suiteDetails.some(function (s) { return s.failedItems && s.failedItems.length > 0; }) ? "\n    <div class=\"info\" style=\"background: #ffebee; border-left: 4px solid #ef4444;\">\n        <h3>\u274C Failed Tests - Detailed Information:</h3>\n        ".concat(summary.suiteDetails.filter(function (suite) { return suite.failedItems && suite.failedItems.length > 0; }).map(function (suite) { return "\n            <div style=\"margin-bottom: 25px;\">\n                <h4 style=\"color: #ef4444; margin-bottom: 15px;\">".concat(suite.icon, " ").concat(suite.displayName, "</h4>\n                <div style=\"margin-left: 15px;\">\n                    ").concat(suite.failedItems.map(function (item, index) { return "\n                        <div style=\"background: white; padding: 12px; border-radius: 6px; margin-bottom: 10px; border: 1px solid #fecaca;\">\n                            <div style=\"font-weight: 600; color: #dc2626; margin-bottom: 5px;\">\n                                ".concat(index + 1, ". ").concat(item.name, "\n                            </div>\n                            ").concat(item.url ? "\n                                <div style=\"font-size: 13px; color: #666; margin-bottom: 4px;\">\n                                    <strong>\uD83D\uDD17 URL:</strong> <code style=\"background: #f3f4f6; padding: 2px 6px; border-radius: 3px;\">".concat(item.url, "</code>\n                                </div>\n                            ") : '', "\n                            ").concat(item.status ? "\n                                <div style=\"font-size: 13px; color: #666; margin-bottom: 4px;\">\n                                    <strong>\uD83D\uDCCA Status:</strong> <span style=\"color: #dc2626;\">".concat(item.status, "</span>\n                                </div>\n                            ") : '', "\n                            ").concat(item.error ? "\n                                <div style=\"font-size: 13px; color: #666; margin-bottom: 4px;\">\n                                    <strong>\u26A0\uFE0F Error:</strong> ".concat(item.error, "\n                                </div>\n                            ") : '', "\n                            ").concat(item.responseMsg ? "\n                                <div style=\"font-size: 13px; color: #666;\">\n                                    <strong>\uD83D\uDCAC Response:</strong> ".concat(item.responseMsg, "\n                                </div>\n                            ") : '', "\n                        </div>\n                    "); }).join(''), "\n                </div>\n            </div>\n        "); }).join(''), "\n    </div>\n    ") : '', "\n\n    ").concat(summary.suiteDetails && summary.suiteDetails.some(function (s) { return s.warningItems && s.warningItems.length > 0; }) ? "\n    <div class=\"info\" style=\"background: #fffbeb; border-left: 4px solid #f59e0b;\">\n        <h3>\u26A0\uFE0F Warnings - Items Requiring Attention:</h3>\n        ".concat(summary.suiteDetails.filter(function (suite) { return suite.warningItems && suite.warningItems.length > 0; }).map(function (suite) { return "\n            <div style=\"margin-bottom: 25px;\">\n                <h4 style=\"color: #d97706; margin-bottom: 15px;\">".concat(suite.icon, " ").concat(suite.displayName, "</h4>\n                <div style=\"margin-left: 15px;\">\n                    ").concat(suite.warningItems.map(function (item, index) { return "\n                        <div style=\"background: white; padding: 12px; border-radius: 6px; margin-bottom: 10px; border: 1px solid #fde68a;\">\n                            <div style=\"font-weight: 600; color: #d97706; margin-bottom: 5px;\">\n                                ".concat(index + 1, ". ").concat(item.name, "\n                            </div>\n                            ").concat(item.url ? "\n                                <div style=\"font-size: 13px; color: #666; margin-bottom: 4px;\">\n                                    <strong>\uD83D\uDD17 URL:</strong> <code style=\"background: #f3f4f6; padding: 2px 6px; border-radius: 3px;\">".concat(item.url, "</code>\n                                </div>\n                            ") : '', "\n                            ").concat(item.status ? "\n                                <div style=\"font-size: 13px; color: #666; margin-bottom: 4px;\">\n                                    <strong>\uD83D\uDCCA Status:</strong> <span style=\"color: #d97706;\">".concat(item.status, "</span>\n                                </div>\n                            ") : '', "\n                            ").concat(item.error ? "\n                                <div style=\"font-size: 13px; color: #666; margin-bottom: 4px;\">\n                                    <strong>\u26A0\uFE0F Message:</strong> ".concat(item.error, "\n                                </div>\n                            ") : '', "\n                            ").concat(item.responseMsg ? "\n                                <div style=\"font-size: 13px; color: #666;\">\n                                    <strong>\uD83D\uDCAC Response:</strong> ".concat(item.responseMsg, "\n                                </div>\n                            ") : '', "\n                        </div>\n                    "); }).join(''), "\n                </div>\n            </div>\n        "); }).join(''), "\n    </div>\n    ") : '', "\n\n    <div class=\"footer\">\n        <p><strong>Ad-Hash Technolabs Pvt Ltd</strong> - Automated Test Monitoring System</p>\n        <p>Generated: ").concat(summary.timestamp, "</p>\n    </div>\n</body>\n</html>\n    ");
                    return [4 /*yield*/, transporter.sendMail({
                            from: "\"AdHash Test Framework\" <".concat(config.from, ">"),
                            to: config.to.join(', '),
                            subject: subject,
                            html: emailBody,
                            attachments: [
                                {
                                    filename: 'AdHash-Projects-Dashboard.html',
                                    content: dashboardHtml,
                                    contentType: 'text/html',
                                },
                            ],
                        })];
                case 2:
                    info = _a.sent();
                    console.log('✅ Email sent successfully!');
                    console.log('📧 Message ID:', info.messageId);
                    console.log('📬 Recipients:', config.to.join(', '));
                    return [3 /*break*/, 4];
                case 3:
                    error_1 = _a.sent();
                    console.error('❌ Error sending email:', error_1);
                    throw error_1;
                case 4: return [2 /*return*/];
            }
        });
    });
}
