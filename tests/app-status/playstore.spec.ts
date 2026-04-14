import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

interface AppData {
  appName: string;
  packageName: string;
  expectedUrl: string;
}

interface ProjectAppConfig {
  name?: string;
  playStore?: string | null;
}

interface ProjectConfig {
  apps?: ProjectAppConfig[];
}

interface ProjectMapping {
  projects?: ProjectConfig[];
}

function normalizePlayStoreValue(playStore: string): { packageName: string; expectedUrl: string } {
  const trimmed = playStore.trim();

  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    const packageName = url.searchParams.get('id') || '';

    return {
      packageName,
      expectedUrl: trimmed
    };
  }

  return {
    packageName: trimmed,
    expectedUrl: `https://play.google.com/store/apps/details?id=${trimmed}`
  };
}

function loadAppData(): AppData[] {
  const mappingPath = path.join(process.cwd(), 'config', 'project-mapping.json');
  const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8')) as ProjectMapping;

  return (mapping.projects || [])
    .flatMap((project) => project.apps || [])
    .filter((app): app is ProjectAppConfig & { name: string; playStore: string } => Boolean(app?.name && app?.playStore))
    .map((app) => {
      const normalized = normalizePlayStoreValue(app.playStore);

      return {
        appName: app.name,
        packageName: normalized.packageName,
        expectedUrl: normalized.expectedUrl
      };
    })
    .filter((app) => Boolean(app.packageName));
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

