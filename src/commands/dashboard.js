/**
 * badgr-auto dashboard — open the AI Badgr dashboard in the default browser.
 */
import { exec } from 'node:child_process';

export const DASHBOARD_URL = 'https://aibadgr.com/dashboard';

function openBrowser(url) {
  const cmd = process.platform === 'win32'
    ? `start "" "${url}"`
    : process.platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, (err) => { /* fire-and-forget */ });
}

export function dashboardCommand(chalk) {
  console.log();
  console.log(chalk.bold('  AI Badgr Dashboard'));
  console.log();
  console.log(`  ${chalk.cyan(DASHBOARD_URL)}`);
  console.log();
  console.log('  Opening in your browser…');
  openBrowser(DASHBOARD_URL);
  console.log();
  console.log('  Dashboard shows:');
  console.log(chalk.dim('  • Savings across all machines'));
  console.log(chalk.dim('  • Which requests cost money'));
  console.log(chalk.dim('  • Route failures and fallbacks'));
  console.log(chalk.dim('  • Full receipt history'));
  console.log();
}
