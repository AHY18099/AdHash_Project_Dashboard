# AdHash Dashboard - Test Count Explanation

## Current Status: Showing 96 Tests (Expected: 110 Tests)

### Why 96 Instead of 110?

The dashboard is currently showing **96 tests** because it's displaying results from **previous test runs** stored in the test report files. The full **110 tests** will only appear after running all 5 test suites.

---

## Test Count Breakdown

### Current Count (96 Tests):
Based on existing test reports and project mapping:

1. **API Endpoints**: 41 tests ✅
2. **Server Health**: 24 tests ✅  
3. **SSL Certificates**: 25 tests ✅
4. **App Status**: 5 tests ✅
5. **Domain Expiry**: ~1 test (partial data)

**Total**: 41 + 24 + 25 + 5 + 1 = **96 tests**

### Expected Count (110 Tests):
After running all test suites:

1. **API Endpoints**: 41 tests
2. **Server Health**: 24 tests
3. **SSL Certificates**: 25 tests
4. **App Status**: 5 tests
5. **Domain Expiry**: 15 tests

**Total**: 41 + 24 + 25 + 5 + 15 = **110 tests**

---

## How to Get 110 Tests Showing

### Step 1: Click "Run All Tests" Button
The button will trigger the execution of all 5 test suites:

1. **Step 1/5**: App Status Tests (Playwright)
   - Repository: `Adhash_App_Status`
   - Command: `npx playwright test tests/unified.spec.ts`
   - Expected: 5 tests

2. **Step 2/5**: Server Health Tests (TypeScript)
   - Repository: `Adhash_AllProjects_Server`
   - Command: `npx ts-node checkMultipleServers.ts`
   - Expected: 24 tests

3. **Step 3/5**: SSL Certificate Tests (Java/TestNG)
   - Repository: `AdHash-Projects-Certificate-Expiry-Test`
   - Command: `mvn test -Dtest=CertificateExpiryTestNG`
   - Expected: 25 tests

4. **Step 4/5**: API Endpoint Tests (Java/TestNG)
   - Repository: `AdHash-API-Test`
   - Command: `mvn test -DsuiteXmlFile=TestNG.xml`
   - Expected: 41 tests

5. **Step 5/5**: Domain Expiry Tests (Node.js)
   - Repository: `AdHash_Domain_Report`
   - Command: `cd godaddy && node index.js`
   - Expected: 15 tests

### Step 2: Wait for Tests to Complete
- Tests run sequentially (one after another)
- Total execution time: ~10-15 minutes
- Dashboard updates in real-time

### Step 3: View Results
- After completion, the dashboard will show **110 total tests**
- Results are saved in `unified-dashboard/index.html`
- Project dashboard will refresh automatically

---

## Current Setup Status

### ✅ Fixed Issues:
1. ✅ All 5 test repositories copied to dashboard directory
2. ✅ `run-all-tests.ts` file added
3. ✅ `regenerate-dashboard.ts` file added
4. ✅ `playwright.config.ts` file added
5. ✅ `dotenv` package installed
6. ✅ Server running on http://localhost:7777/

### 📊 Test Repositories:
- ✅ `Adhash_App_Status/` - App status tests
- ✅ `Adhash_AllProjects_Server/` - Server health tests
- ✅ `AdHash-Projects-Certificate-Expiry-Test/` - SSL certificate tests
- ✅ `AdHash-API-Test/` - API endpoint tests
- ✅ `AdHash_Domain_Report/` - Domain expiry tests

### 🎯 Next Action:
**Click the "▶ Run All Tests" button** on the dashboard to execute all 110 tests!

---

## Technical Details

### Dashboard Pages:
1. **`public/index.html`** - Main dashboard (shows unified results)
2. **`public/project-dashboard.html`** - Project-wise view (currently showing 96)
3. **`public/project-detail.html`** - Individual project details
4. **`unified-dashboard/index.html`** - Generated after running all tests (shows 110)

### Data Sources:
- **Project Mapping**: `config/project-mapping.json` (defines all projects and resources)
- **Test Reports**: Individual HTML reports from each test repository
- **Unified Dashboard**: Aggregated results from all 5 test suites

### API Endpoints:
- `/api/test-counts` - Returns test counts from repositories
- `/api/test-results` - Returns results from unified dashboard
- `/api/project/:id/test-results` - Returns results for specific project
- `/api/run-tests` - Triggers execution of all test suites

---

**Last Updated**: 2026-02-12  
**Status**: Ready to run all 110 tests!

