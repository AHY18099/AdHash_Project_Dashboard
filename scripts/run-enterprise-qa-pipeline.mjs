import { spawnSync } from 'child_process';

function runStep(label, command, args, env = process.env) {
  console.log(`\n[qa:enterprise] ${label}`);
  const useShell = process.platform === 'win32';
  const result = useShell
    ? spawnSync([command, ...args].join(' '), {
        stdio: 'inherit',
        env,
        cwd: process.cwd(),
        shell: true
      })
    : spawnSync(command, args, {
        stdio: 'inherit',
        env,
        cwd: process.cwd()
      });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

const npmCommand = 'npm';
const npxCommand = 'npx';
const emailEnabled = String(process.env.ZOHO_MAIL_ENABLED || '').trim().toLowerCase() === 'true';
const previewEnv = {
  ...process.env,
  ZOHO_MAIL_ENABLED: 'false'
};

runStep('1/6 clean artifacts', npmCommand, ['run', 'clean:artifacts']);
runStep('2/6 API suite', npxCommand, ['playwright', 'test', 'tests/api/api-tests.spec.ts']);
runStep('3/6 unified suite run', npxCommand, ['ts-node', 'run-all-tests.ts', '--skip-clean']);
runStep('4/6 regenerate preview without send', npxCommand, ['ts-node', 'regenerate-dashboard.ts'], previewEnv);
runStep('5/6 validate report consistency', npmCommand, ['run', 'validate:report']);

if (emailEnabled) {
  runStep('6/6 generate and send validated email', npxCommand, ['ts-node', 'regenerate-dashboard.ts']);
  console.log('[qa:enterprise] Email send allowed after validation');
} else {
  console.log('[qa:enterprise] Email send blocked because ZOHO_MAIL_ENABLED is not true');
}

console.log('[qa:enterprise] Enterprise QA pipeline completed');