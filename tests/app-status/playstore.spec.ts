import { test } from '@playwright/test';
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
  const projectFilter = process.env.PROJECT_FILTER ? process.env.PROJECT_FILTER.toLowerCase().trim() : '';

  return (mapping.projects || [])
    .filter((project: any) => !projectFilter || (project.id || '').toLowerCase() === projectFilter)
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

      let appStatus: 'passed' | 'failed' = 'failed';
      let appReason = '';
      try {
        await page.goto(app.expectedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForFunction(() => document.title.length > 0, { timeout: 15000 }).catch(() => {});

        const pageTitle = await page.title();
        const titleLower = pageTitle.toLowerCase();
        const appNameLower = app.appName.toLowerCase();

        // Split app name into words, check if any significant word (>2 chars) appears in the title
        const words = appNameLower.split(/\s+/).filter(w => w.length > 2);
        const titleMatches = words.some(w => titleLower.includes(w));

        if (titleMatches) {
          appStatus = 'passed';
          appReason = pageTitle;
        } else {
          appReason = `App name words not found in page title: "${pageTitle}"`;
        }
      } catch (error: any) {
        appStatus = 'failed';
        appReason = error.message || String(error);
      }

      // Emit structured marker for server to parse
      console.log(`__APP_RESULT__${JSON.stringify({ appName: app.appName, platform: app.platform, status: appStatus, reason: appReason })}`);

      if (appStatus === 'failed') {
        throw new Error(appReason);
      }
    });
  }
});

