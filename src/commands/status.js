import { isProxyRunning, readProxyPid, loadProxyConfig, PROXY_PORT } from '../proxy-config.js';

const PROXY_URL = `http://localhost:${PROXY_PORT}/v1`;

export function statusCommand(chalk) {
  const running = isProxyRunning();
  const pid     = readProxyPid();
  const cfg     = loadProxyConfig();

  console.log();
  if (running) {
    console.log(chalk.green('  Badgr Token Proxy: running'));
    console.log(`  PID:       ${pid}`);
    console.log(`  Base URL:  ${PROXY_URL}`);
    console.log(`  Routing:   edge → mid → async → premium`);
    console.log(`  Default:   mid-tier (${cfg.midBaseUrl || cfg.upstreamBaseUrl})`);
    console.log(`  Threshold: ${cfg.compressionThresholdTokens.toLocaleString()} tokens`);
    console.log(`  Recent:    ${cfg.recentMessagesToKeep} messages kept untouched`);
  } else {
    console.log(chalk.dim('  Badgr Token Proxy: not running'));
    console.log(`  Run ${chalk.cyan('badgr-auto start')} to start.\n`);
    return;
  }
  console.log();
}
