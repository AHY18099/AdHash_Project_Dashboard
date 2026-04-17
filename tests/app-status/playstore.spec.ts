import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

interface AppData {
  appName: string;
  storeId: string;
  expectedUrl: string;
  platform: 'Play Store' | 'App Store';
  projectName: string;
}

interface ProjectAppConfig {
  name?: string;
  playStore?: string | null;
  appStore?: string | null;
}

interface ProjectConfig {
  name?: string;
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

function normalizeAppStoreValue(appStore: string): { appId: string; expectedUrl: string } {
  const trimmed = appStore.trim();

  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    const appIdMatch = url.pathname.match(/(id\d+)/i);
    const appId = appIdMatch?.[1] || '';

    return {
      appId,
      expectedUrl: trimmed
    };
  }

  const appId = trimmed.startsWith('id') ? trimmed : `id${trimmed}`;
  return {
    appId,
    expectedUrl: `https://apps.apple.com/app/${appId}`
  };
}

function loadAppData(): AppData[] {
  const mappingPath = path.join(process.cwd(), 'config', 'project-mapping.json');
  const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8')) as ProjectMapping;

  return (mapping.projects || [])
    .flatMap((project) => {
      const apps = project.apps || [];
      const playStoreCount = apps.filter((app) => Boolean(app?.playStore)).length;
      const appStoreCount = apps.filter((app) => Boolean(app?.appStore)).length;
      const normalizedApps: AppData[] = [];

      for (const app of apps) {
        if (!app?.name) {
          continue;
        }

        if (app.playStore) {
          const normalizedPlayStore = normalizePlayStoreValue(app.playStore);
          if (normalizedPlayStore.packageName) {
            normalizedApps.push({
              appName: app.name,
              storeId: normalizedPlayStore.packageName,
              expectedUrl: normalizedPlayStore.expectedUrl,
              platform: 'Play Store',
              projectName: project.name || app.name
            });
          }
        }

        if (app.appStore) {
          const normalizedAppStore = normalizeAppStoreValue(app.appStore);
          if (normalizedAppStore.appId) {
            normalizedApps.push({
              appName: app.name,
              storeId: normalizedAppStore.appId,
              expectedUrl: normalizedAppStore.expectedUrl,
              platform: 'App Store',
              projectName: project.name || app.name
            });
          }
        }
      }

      console.log(`[APP STATUS] project name: ${project.name || 'Unknown'}, playStore count: ${playStoreCount}, appStore count: ${appStoreCount}, total normalized apps: ${normalizedApps.length}`);
      return normalizedApps;
    })
    .filter((app) => Boolean(app.storeId));
}

test.describe('App Storefront Verification', () => {
  const apps = loadAppData();

  for (const app of apps) {
    test(`Verify ${app.appName} on ${app.platform}`, async ({ page }) => {
      test.setTimeout(60000);

      try {
        // Navigate to the configured store page
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
          console.log(`✓ ${app.appName} found on ${app.platform}`);
        } else {
          console.log(`⚠ ${app.appName} ${app.platform} page loaded but name not immediately visible`);
        }

        // Take screenshot for verification
        const screenshotDir = path.join(process.cwd(), 'test-results', 'screenshots', app.platform === 'Play Store' ? 'playstore' : 'appstore');
        if (!fs.existsSync(screenshotDir)) {
          fs.mkdirSync(screenshotDir, { recursive: true });
        }
        
        await page.screenshot({ 
          path: path.join(screenshotDir, `${app.storeId}.png`),
          fullPage: true 
        });

      } catch (error) {
        console.error(`✗ Error verifying ${app.appName} on ${app.platform}:`, error);
        throw error;
      }
    });
  }
});

