import { input } from '@inquirer/prompts';
import { loadConfig, saveConfig, DEFAULTS } from '../config.js';

export async function loginCommand(chalk, args = []) {
  // Non-interactive path: --api-key <key>  or  --ci (reads env BADGR_API_KEY)
  const apiKeyIdx = args.indexOf('--api-key');
  const cliKey    = apiKeyIdx >= 0 ? (args[apiKeyIdx + 1] || '') : '';
  const isCI      = args.includes('--ci');
  const envKey    = process.env.BADGR_API_KEY || '';
  const nonInteractiveKey = cliKey.trim() || (isCI ? envKey.trim() : '');

  if (nonInteractiveKey) {
    saveConfig({ apiKey: nonInteractiveKey, baseUrl: DEFAULTS.baseUrl });
    console.log();
    console.log(chalk.green('  ✓ API key saved'));
    console.log(chalk.green('  ✓ Connected to AI Badgr'));
    console.log(chalk.green('  ✓ Key saved to ~/.badgr/config.json'));
    console.log();
    return;
  }

  // Interactive path (default)
  console.log();
  console.log(chalk.bold('  badgr-auto login'));
  console.log();
  console.log('  Step 1 — Sign in to AI Badgr and copy your API key:');
  console.log();
  console.log(`  ${chalk.cyan('https://aibadgr.com/login')}`);
  console.log();

  const apiKey = await input({
    message: '  Paste your AI Badgr API key:',
    validate: v => v.trim() ? true : 'API key is required',
  });

  saveConfig({ apiKey: apiKey.trim(), baseUrl: DEFAULTS.baseUrl });

  // Validate against the AI Badgr API
  const config = loadConfig();
  let validated = false;
  try {
    const res = await fetch(`${config.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    validated = res.ok || res.status === 404;
    if (res.status === 401 || res.status === 403) {
      console.log();
      console.log(chalk.yellow('  ⚠ API key was not accepted. Double-check and run badgr-auto login again.'));
      return;
    }
  } catch {
    // Network unavailable — save anyway and warn
  }

  console.log();
  console.log(chalk.green('  ✓ Connected to AI Badgr'));
  if (validated) console.log(chalk.green('  ✓ API key validated'));
  console.log(chalk.green('  ✓ Key saved to ~/.badgr/config.json'));
  console.log();
  console.log('  Next step:');
  console.log(`    ${chalk.cyan('badgr-auto start')}`);
  console.log();
}
