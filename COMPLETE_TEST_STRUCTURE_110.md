# AdHash Dashboard - Complete Test Structure (110 Tests)

## 📊 **Total Tests: 110 Tests**

The AdHash Dashboard monitors **110 automated tests** across **5 main test suites** covering all AdHash projects.

---

## 🧪 **Test Breakdown by Category**

### **1. API Endpoint Tests - 41 Tests**
**Location:** `tests/api/api-tests.spec.ts` (Playwright) + `AdHash-API-Test/TestNG.xml` (TestNG)

**Purpose:** Tests HTTP endpoints across all AdHash projects to ensure they're accessible and responding correctly.

**Projects & Endpoints:**
1. **AdHash** - 1 endpoint (Website)
2. **AutoChecker** - 3 endpoints (Login UI, Admin Login, App Login)
3. **WavedIn** - 3 endpoints (App Login, SuperAdmin UI, Market Web)
4. **Sparkme** - 3 endpoints (App Login, Web Login UI, Web Login)
5. **Algomax** - 2 endpoints (ProSky Web, GoPocket Web)
6. **Metcalf** - 1 endpoint (UI)
7. **Humee** - 5 endpoints (Admin Web UI, Dashboard Web UI, Dashboard Login Number, Dashboard Login OTP, Dashboard Login)
8. **AiSignPro** - 18 endpoints (SuperAdmin UI, SuperAdmin Check User, SuperAdmin OTP, SuperAdmin Login, DDP Admin Check User, DDP Admin OTP, DDP Admin Login, Accountant Check User, Accountant OTP, Accountant Login, CPA UI, CPA Check User, CPA OTP, CPA Login, Participant UI, Participant Check User, Participant OTP, Participant Login)
9. **ZapAI** - 1 endpoint (UI)
10. **ZapCRM** - 3 endpoints (UI, Secure UI, Social UI)
11. **LeadZapCRM** - 1 endpoint (UI)

**Total:** **41 API endpoint tests**

---

### **2. Server Health Tests - 24 Tests**
**Location:** `tests/server-health/server-check.spec.ts` (Playwright) + `Adhash_AllProjects_Server/monitorMultipleServers.ts`

**Purpose:** Monitors server uptime, response times, and health status for all production servers.

**Servers Monitored:**
1. **AutoChecker** - 7 servers
   - Auto Search (http://20.7.146.191:3000/)
   - Manual Search (http://20.15.121.70:3000/)
   - PartSouq (http://20.62.109.239:3000/)
   - Admin (https://manage.autochecker.com/)
   - Admin API (https://manageadminapi.autochecker.com/)
   - Mobile API (https://managemobileapi.autochecker.com/)
   - eBay API (https://ebaydev.autochecker.com/)

2. **WavedIn** - 2 servers
   - Mobile API (https://mobileliveapi.wavedin.app/)
   - Super Admin (https://superadmin.wavedin.app/)

3. **ZapAI** - 1 server (https://www.zapai.us/)

4. **ZapCRM** - 4 servers
   - Admin (https://zapcrm.io/)
   - Lead (https://lead.zapcrm.io/)
   - API (https://api.zapcrm.io/)
   - Secure (https://secure.zapcrm.io/)
   - Social (https://social.zapcrm.io/)

5. **Algomax** - 1 server (GoPocket - https://gopocket.algomax.co/)

6. **Metcalf** - 1 server (https://metcalf.ai/)

7. **AdHash** - 1 server (https://adhashtech.com/)

8. **Humee** - 2 servers
   - Admin (https://humee.com/)
   - API (https://api.humee.com/)

9. **SMC** - 1 server (API - https://api.sendmovieclips.com/)

10. **AiSignPro** - 2 servers
    - Admin (https://admin.aisignpro.com/)
    - API (https://api.aisignpro.com/)

11. **Synctag** - 1 server (API - https://spark.synctag.com/)

**Total:** **24 server health tests**

---

### **3. SSL Certificate Tests - 25 Tests**
**Location:** `tests/certificate/cert-expiry.spec.ts` (Playwright) + `AdHash-Projects-Certificate-Expiry-Test/src/test/java/Certify/CertificateExpiryTestNG.java`

**Purpose:** Monitors SSL certificate expiry dates for all domains to prevent security issues and downtime.

**Domains Monitored:**
- **Main Project Domains:** 16 domains
  - Algomax (GoPocket, ProSky)
  - WavedIn (Admin, Marketplace, Mobile API)
  - Auto Checker
  - Spark me
  - ZapAI, ZapCRM, Lead ZapCRM
  - Metcalf
  - Humee (Admin, Dashboard, API)
  - AiSignPro (Admin, CPA, Participant, API)
  - AdHash Website
  - SMC API

- **API Endpoint Domains:** 9 domains
  - WavedIn API
  - Auto Checker APIs (3)
  - Spark me API
  - ZapCRM Lead API
  - Humee API
  - AiSignPro API
  - SMC API

**Warning Threshold:** 30 days before expiry

**Total:** **25 SSL certificate tests**

---

### **4. App Status Tests - 5 Tests**
**Location:** `tests/app-status/playstore.spec.ts` (Playwright) + `Adhash_App_Status/tests/unified.spec.ts`

**Purpose:** Verifies that mobile apps are published and accessible on Google Play Store.

**Apps Tested:**
1. **AutoChecker** (`com.autochecker`)
2. **WavedIn** (`com.waivedin`)
3. **AlgoMax** (`com.algomax`)
4. **Auto eVantage** (`com.autoevantage`)
5. **Spark Me** (`com.adhash.sparkme`)

**Total:** **5 app status tests**

---

### **5. Domain Expiry Tests - 15 Tests**
**Location:** `AdHash_Domain_Report/godaddy/index.js`

**Purpose:** Monitors domain registration expiry dates to prevent domain loss.

**Domains Monitored:** 15 critical domains (subset of the 36 total domains)

**Warning Threshold:** 90 days before expiry

**Total:** **15 domain expiry tests**

---

## 🎯 **Test Execution Summary**

```
Total Tests: 110

├── API Endpoint Tests: 41 (37.27%)
├── Server Health Tests: 24 (21.82%)
├── SSL Certificate Tests: 25 (22.73%)
├── Domain Expiry Tests: 15 (13.64%)
└── App Status Tests: 5 (4.55%)
```

---

## 🚀 **Test Frameworks & Technologies**

1. **Playwright (TypeScript)** - Modern test automation
   - API endpoint tests
   - Server health monitoring
   - SSL certificate checks
   - App status verification

2. **TestNG (Java)** - Enterprise testing framework
   - API endpoint tests (alternative implementation)
   - SSL certificate expiry tests (alternative implementation)

3. **Node.js Scripts** - Custom monitoring
   - Domain expiry monitoring
   - Server health checks

---

## 📁 **Project Structure**

```
AdHash_Dashboard/
├── tests/                                  (Playwright tests - 96 tests)
│   ├── api/api-tests.spec.ts             (42 tests: 41 endpoints + 1 summary)
│   ├── app-status/playstore.spec.ts      (5 tests)
│   ├── certificate/cert-expiry.spec.ts   (26 tests: 25 certs + 1 summary)
│   └── server-health/server-check.spec.ts (23 tests: 22 servers + 1 summary)
│
├── AdHash-API-Test/                        (TestNG API tests - 41 tests)
│   └── TestNG.xml
│
├── AdHash_Domain_Report/                   (Domain expiry - 15 tests)
│   └── godaddy/index.js
│
├── config/project-mapping.json             (Project configuration)
├── server.js                               (Dashboard server)
└── public/
    ├── index.html                          (Main dashboard)
    └── project-dashboard.html              (Project-wise view)
```

---

**Last Updated:** 2026-02-12  
**Total Test Count:** **110 tests** across 5 test suites

