# AdHash Dashboard - Test Structure Overview

## 📊 Total Tests: 96 Tests

The dashboard runs **96 automated tests** across 4 main test suites to monitor all AdHash projects.

---

## 🧪 Test Breakdown by Category

### 1. **API Endpoint Tests** - 42 Tests
**File:** `tests/api/api-tests.spec.ts`

Tests HTTP endpoints across all AdHash projects to ensure they're accessible and responding correctly.

**Projects Covered:**
- **AdHash** (1 endpoint)
- **AutoChecker** (1 endpoint)
- **KaiCare AI** (4 endpoints)
- **MyHealth CCM** (6 endpoints)
- **MyHealth RTM** (3 endpoints)
- **WavedIn** (2 endpoints)
- **Sparkme/Synctag** (1 endpoint)
- **Algomax** (2 endpoints)
- **ZapCRM** (5 endpoints)
- **AskEPI** (1 endpoint)
- **RiskRealm** (2 endpoints)
- **AutoeVantage** (3 endpoints)
- **Metcalf** (1 endpoint)
- **Humee** (5 endpoints)
- **AiSignPro** (3 endpoints)
- **ZapAI** (1 endpoint)
- **Summary Test** (1 test)

**Total:** 41 individual endpoint tests + 1 summary test = **42 tests**

---

### 2. **App Status Tests** - 5 Tests
**File:** `tests/app-status/playstore.spec.ts`

Verifies that mobile apps are published and accessible on Google Play Store.

**Apps Tested:**
1. AutoChecker (`com.autochecker`)
2. WavedIn (`com.waivedin`)
3. AlgoMax (`com.algomax`)
4. Auto Evantage (`com.autoevantage`)
5. Spark Me (`com.adhash.sparkme`)

**Total:** **5 tests**

---

### 3. **SSL Certificate Tests** - 26 Tests
**File:** `tests/certificate/cert-expiry.spec.ts`

Monitors SSL certificate expiry dates for all domains to prevent security issues.

**Domains Monitored:**
- **Main Projects:** 16 domains
  - Algomax (GoPocket, ProSky)
  - WavedIn (Admin, Marketplace)
  - Auto Checker
  - Spark me
  - ZapAI, ZapCRM, Lead ZapCRM
  - Metcalf
  - Humee (Admin, Dashboard)
  - AiSignPro (Admin, CPA, Participant)
  - AdHash Website

- **API Endpoints:** 9 domains
  - WavedIn API
  - Auto Checker APIs (3)
  - Spark me API
  - ZapCRM Lead API
  - Humee API
  - AiSignPro API
  - SMC API

**Total:** 25 individual certificate tests + 1 summary test = **26 tests**

---

### 4. **Server Health Tests** - 23 Tests
**File:** `tests/server-health/server-check.spec.ts`

Monitors server uptime and response times for all production servers.

**Servers Monitored:**
- **AutoChecker:** 7 servers (Auto Search, Manual Search, PartSouq, Admin, Admin API, Mobile API, eBay API)
- **WavedIn:** 2 servers (Mobile API, Super Admin)
- **Zapai:** 1 server
- **Zapcrm:** 3 servers (Admin, Lead, API)
- **Algomax:** 1 server (GoPocket)
- **Metcalf:** 1 server
- **AdHash:** 1 server
- **Humee:** 2 servers (Admin, API)
- **SMC:** 1 server (API)
- **AiSignPro:** 2 servers (Admin, API)
- **Synctag:** 1 server (API)

**Total:** 22 individual server tests + 1 summary test = **23 tests**

---

## 🎯 Test Execution Summary

```
Total Tests: 96
├── API Endpoint Tests: 42 (43.75%)
├── SSL Certificate Tests: 26 (27.08%)
├── Server Health Tests: 23 (23.96%)
└── App Status Tests: 5 (5.21%)
```

---

## 🚀 How Tests Are Executed

### Test Runner: Playwright
- **Configuration:** `playwright.config.ts`
- **Browser:** Chromium (Desktop Chrome)
- **Parallel Execution:** Yes (fully parallel)
- **Retries:** 1 retry on failure (2 in CI)
- **Timeout:** 120 seconds per test
- **Action Timeout:** 30 seconds
- **Navigation Timeout:** 60 seconds

### Reporters:
1. **HTML Report:** `playwright-report/index.html`
2. **JSON Report:** `test-results/results.json`
3. **List Reporter:** Console output
4. **Unified HTML Reporter:** `unified-report/index.html` (custom)

---

## 📁 Project Structure

```
AdHash_Dashboard/
├── tests/
│   ├── api/
│   │   └── api-tests.spec.ts          (42 tests)
│   ├── app-status/
│   │   └── playstore.spec.ts          (5 tests)
│   ├── certificate/
│   │   └── cert-expiry.spec.ts        (26 tests)
│   └── server-health/
│       └── server-check.spec.ts       (23 tests)
├── server.js                          (Dashboard server)
├── public/
│   ├── index.html                     (Main dashboard UI)
│   ├── project-dashboard.html         (Project-wise view)
│   └── project-detail.html            (Project details)
├── utils/
│   ├── UnifiedHtmlReporter.ts         (Custom reporter)
│   ├── dashboard-generator.ts         (Dashboard generator)
│   └── email-sender.ts                (Email notifications)
└── playwright.config.ts               (Test configuration)
```

---

## 🎨 Dashboard Features

1. **Real-time Test Execution** - Run all 96 tests with one click
2. **Live Progress Updates** - Server-Sent Events (SSE) for real-time updates
3. **Detailed Results** - View pass/fail status for each test
4. **Project-wise Organization** - Tests grouped by project
5. **Beautiful UI** - Dark theme with peacock green gradient
6. **Performance Metrics** - Response times and health status
7. **Screenshot Capture** - Failed tests automatically capture screenshots

---

## 🔧 Running Tests

### Run All Tests:
```bash
npx playwright test
```

### Run Specific Suite:
```bash
npx playwright test tests/api/
npx playwright test tests/app-status/
npx playwright test tests/certificate/
npx playwright test tests/server-health/
```

### List All Tests:
```bash
npx playwright test --list
```

---

**Last Updated:** 2026-02-12
**Total Test Count:** 96 tests across 4 suites

