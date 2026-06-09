import { stopCommand } from './stop.js';
import { loadConfig } from '../config.js';
import {
  isProxyRunning, saveProxyConfig, writeProxyPid,
  PROXY_PORT, readProxyPid,
} from '../proxy-config.js';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const PROXY_SCRIPT = join(__dirname, '..', 'proxy-server.js');
const PROXY_URL    = `http://localhost:${PROXY_PORT}/v1`;

async function waitForProxy(port, ms = 6000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://localhost:${port}/v1/models`, { signal: AbortSignal.timeout(500) });
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 300));
    }
  }
  return false;
}

export async function restartCommand(chalk) {
  stopCommand(chalk);
  await new Promise(r => setTimeout(r, 400));

  const config = loadConfig();
  if (config.baseUrl) {
    const upstream = config.baseUrl.replace(/\/+$/, '');
    saveProxyConfig({ upstreamBaseUrl: upstream, midBaseUrl: upstream });
  }

  const child = spawn(process.execPath, [PROXY_SCRIPT], { detached: true, stdio: 'ignore' });
  child.unref();
  writeProxyPid(child.pid);

  process.stdout.write('  Starting proxy…');
  const ready = await waitForProxy(PROXY_PORT);
  process.stdout.write('\r' + ' '.repeat(30) + '\r');

  if (ready) {
    console.log(chalk.green(`\n  ✓ Badgr Auto restarted at ${PROXY_URL}\n`));
  } else {
    console.log(chalk.yellow('\n  Proxy did not start in time. Try badgr-auto start again.\n'));
  }
}
