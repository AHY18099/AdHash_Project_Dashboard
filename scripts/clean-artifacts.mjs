import fs from 'fs';
import path from 'path';

const generatedDirectories = [
  'suite-reports',
  'test-results',
  'playwright-report',
  'unified-dashboard',
  'final-dashboard-bundle',
  'email-preview'
];

for (const relativeDir of generatedDirectories) {
  const absoluteDir = path.join(process.cwd(), relativeDir);
  fs.rmSync(absoluteDir, { recursive: true, force: true });
  console.log(`[clean:artifacts] removed ${relativeDir}`);
}

console.log('[clean:artifacts] completed');