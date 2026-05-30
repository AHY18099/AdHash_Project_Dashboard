# AdHash Projects Status Dashboard

A unified dashboard for running and monitoring all AdHash project test suites in one place.

## Features

- 🚀 **Single Click Execution** - Run all test suites with one button click
- 📊 **Live Results** - View test results in real-time as they execute
- 🎨 **Beautiful UI** - Modern, responsive dashboard interface
- 📈 **Comprehensive Reporting** - Detailed statistics for each test suite
- 🔄 **Real-time Updates** - Server-Sent Events for live progress tracking

## Test Suites Included

1. **📱 App Status Verification** - Play Store & App Store verification
2. **🖥️ Server Health Monitoring** - Production server health checks
3. **🔒 SSL Certificate Monitoring** - SSL certificate expiry checks
4. **🌐 API Endpoint Testing** - Comprehensive API testing

## Quick Start

### 1. Start the Dashboard Server

```bash
npm start
```

### 2. Open the Dashboard

Open your browser and navigate to:
```
http://localhost:7777
```

### 3. Run Tests

Click the **"Run All Tests"** button in the dashboard to execute all test suites.

## How It Works

1. The dashboard runs on a Node.js/Express server
2. When you click "Run All Tests", the server executes each test suite sequentially
3. Results are streamed back to the browser in real-time using Server-Sent Events (SSE)
4. Each test suite displays:
   - Status (Success/Failed)
   - Statistics (Total, Passed, Failed, Warnings)
   - Duration
   - Detailed test results

## Project Structure

```
AdHash_Dashboard/
├── public/
│   └── index.html          # Dashboard UI
├── server.js               # Express server & test runner
├── tests/                  # Test suites
│   ├── app-status/        # App verification tests
│   ├── server-health/     # Server health tests
│   ├── certificate/       # SSL certificate tests
│   └── api/               # API endpoint tests
├── utils/                  # Utility functions
├── package.json           # Dependencies
└── playwright.config.ts   # Playwright configuration
```

## Requirements

- Node.js (v18 or higher)
- npm (v9 or higher)
- Windows/Mac/Linux

## Notes

- All tests run locally - nothing is committed to the repository
- The dashboard automatically refreshes results after each test suite completes
- Logs are displayed in real-time at the bottom of the dashboard
- You can run tests multiple times without restarting the server

## Troubleshooting

If you encounter any issues:

1. Make sure all dependencies are installed: `npm install`
2. Ensure Playwright browsers are installed: `npx playwright install chromium`
3. Check that port 7777 is not in use by another application
4. Clear your browser cache and refresh the page

## Fresh Email Workflow

Use this workflow when generating the email report so stale artifacts cannot leak into the DDP API counts:

```bash
npm run workflow:email
```

This enforces the required order:

1. Clean `suite-reports`, `test-results`, `unified-dashboard`, `final-dashboard-bundle`, and `email-preview`
2. Run `tests/api/api-tests.spec.ts`
3. Run `ts-node run-all-tests.ts --skip-clean`
4. Run `ts-node regenerate-dashboard.ts`

`run-all-tests.ts` no longer sends the email. The email is generated only during `regenerate-dashboard.ts`, after the dashboard has been rebuilt from the current run.

## Support

For issues or questions, please contact the AdHash development team.

