import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  loadProxyConfig, saveProxyConfig,
  readProxyPid, writeProxyPid, isProxyRunning, PROXY_PORT,
} from '../proxy-config.js';
import { loadConfig } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const PROXY_SCRIPT = join(__dirname, '..', 'proxy-server.js');
const PROXY_URL    = `http://localhost:${PROXY_PORT}/v1`;

function parseArgs(args) {
  const updates = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--upstream' && args[i + 1]) {
      updates.upstreamBaseUrl = args[++i].replace(/\/+$/, '');
      updates.midBaseUrl = updates.upstreamBaseUrl;
    }
    if (args[i] === '--threshold' && args[i + 1]) updates.compressionThresholdTokens = Number.parseInt(args[++i], 10);
    if (args[i] === '--recent' && args[i + 1]) updates.recentMessagesToKeep = Number.parseInt(args[++i], 10);
  }
  return updates;
}

export async function startCommand(chalk, args = []) {
  const updates = parseArgs(args);
  const config = loadConfig();
  if (!updates.upstreamBaseUrl && config.apiKey && config.baseUrl) {
    const upstream = config.baseUrl.replace(/\/+$/, '');
    updates.upstreamBaseUrl = upstream;
    updates.midBaseUrl = upstream;
  }
  saveProxyConfig(updates);

  if (isProxyRunning()) {
    const pid = readProxyPid();
    console.log(chalk.green(`\n  ✓ Badgr Auto already running (PID ${pid}) at ${PROXY_URL}\n`));
    return;
  }

  if (!config.apiKey) {
    console.log(chalk.yellow('\n  No API key found. Run badgr-auto login first.\n'));
  }

  const child = spawn(process.execPath, [PROXY_SCRIPT], { detached: true, stdio: 'ignore' });
  child.unref();
  writeProxyPid(child.pid);

  console.log();
  console.log(chalk.green('  ✓ Badgr Auto running at ' + PROXY_URL));
  console.log();
  console.log('  Use this in Cline, Continue, or Aider:');
  console.log();
  console.log(`    Base URL: ${chalk.cyan(PROXY_URL)}`);
  console.log(`    API Key:  ${chalk.dim(config.apiKey ? `${config.apiKey.slice(0, 8)}...` : '<your AI Badgr API key>')}`);
  console.log(`    Model:    ${chalk.cyan('badgr-auto')}`);
  console.log();
  console.log(chalk.dim('  What it does:'));
  console.log(chalk.dim('    Dedupes repeated context, compresses long sessions,'));
  console.log(chalk.dim('    routes edge / mid / premium, preserves streaming, logs savings.'));
  console.log();
  console.log(`  ${chalk.dim('badgr-auto stop')}     to shut down`);
  console.log(`  ${chalk.dim('badgr-auto stats')}    to see token savings`);
  console.log();
}
