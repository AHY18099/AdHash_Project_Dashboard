import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

interface AppData {
  appName: string;
  packageName: string;
  expectedUrl: string;
}

// Real app data from Adhash_App_Status repository (config/unifiedTestData.ts)
function loadAppData(): AppData[] {
  // Real data from your cloned repository
  const realAppData: AppData[] = [
    {
      appName: 'AutoChecker',
      packageName: 'com.autochecker',
      expectedUrl: 'https://play.google.com/store/apps/details?id=com.autochecker'
    },
    {
      appName: 'WavedIn',
      packageName: 'com.waivedin',
      expectedUrl: 'https://play.google.com/store/apps/details?id=com.waivedin'
    },
    {
      appName: 'AlgoMax',
      packageName: 'com.algomax',
      expectedUrl: 'https://play.google.com/store/apps/details?id=com.algomax'
    },
    {
      appName: 'Auto Evantage',
      packageName: 'com.autoevantage',
      expectedUrl: 'https://play.google.com/store/apps/details?id=com.autoevantage'
    },
    {
      appName: 'Spark Me',
      packageName: 'com.adhash.sparkme',
      expectedUrl: 'https://play.google.com/store/apps/details?id=com.adhash.sparkme'
    }
  ];

  return realAppData;
}

test.describe('Play Store App Verification', () => {
  const apps = loadAppData();

  for (const app of apps) {
    test(`Verify ${app.appName} on Play Store`, async ({ page }) => {
      test.setTimeout(60000);

      try {
        // Navigate to Play Store
        await page.goto(app.expectedUrl, { 
          waitUntil: 'domcontentloaded',
          timeout: 30000 
        });

        // Wait for the page to load
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

        // Check if app exists (page doesn't show 404)
        const pageTitle = await page.title();
        expect(pageTitle).not.toContain('Not Found');
        expect(pageTitle).not.toContain('404');

        // Try to find app name on the page
        const appNameLocator = page.locator(`text=${app.appName}`).first();
        const isVisible = await appNameLocator.isVisible({ timeout: 5000 }).catch(() => false);

        if (isVisible) {
          console.log(`✓ ${app.appName} found on Play Store`);
        } else {
          console.log(`⚠ ${app.appName} page loaded but name not immediately visible`);
        }

        // Take screenshot for verification
        const screenshotDir = path.join(process.cwd(), 'test-results', 'screenshots', 'playstore');
        if (!fs.existsSync(screenshotDir)) {
          fs.mkdirSync(screenshotDir, { recursive: true });
        }
        
        await page.screenshot({ 
          path: path.join(screenshotDir, `${app.packageName}.png`),
          fullPage: true 
        });

      } catch (error) {
        console.error(`✗ Error verifying ${app.appName}:`, error);
        throw error;
      }
    });
  }
});

