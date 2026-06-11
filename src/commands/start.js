import { spawn, exec } from 'child_process';
import http from 'node:http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { select, input } from '@inquirer/prompts';
import {
  loadProxyConfig, saveProxyConfig,
  readProxyPid, writeProxyPid, clearProxyPid, isProxyRunning, PROXY_PORT, PROXY_PORTS, readProxyPort,
} from '../proxy-config.js';
import { loadConfig, saveConfig, DEFAULTS } from '../config.js';
import { detectLocalServers } from '../detect.js';
import { detectHardware, selectBestLocalModel } from '../hardware.js';
import { probeProxy } from '../probe-proxy.js';
import { waitForProxy } from '../wait-for-proxy.js';
import { stopCommand } from './stop.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const PROXY_SCRIPT = join(__dirname, '..', 'proxy-server.js');

function getProxyUrl() {
  return `http://localhost:${readProxyPort()}/v1`;
}

// Used in places that need a URL before the proxy starts (e.g. already-running path).
const PROXY_URL    = `http://localhost:${PROXY_PORT}/v1`;

export function parseArgs(args) {
  const updates = {};
  let forceWizard = false;
  let forceRestart = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--upstream' && args[i + 1]) {
      updates.upstreamBaseUrl = args[++i].replace(/\/+$/, '');
      updates.midBaseUrl = updates.upstreamBaseUrl;
    }
    if (args[i] === '--threshold' && args[i + 1]) updates.compressionThresholdTokens = Number.parseInt(args[++i], 10);
    if (args[i] === '--recent' && args[i + 1]) updates.recentMessagesToKeep = Number.parseInt(args[++i], 10);
    if (args[i] === '--no-route') updates.routingMode = 'direct';
    if (args[i] === '--no-optimize') updates.tokenOptimization = false;
    if (args[i] === '--eval-sample' && args[i + 1]) updates.evalSampleRate = parseFloat(args[++i]);
    if (args[i] === '--setup') forceWizard = true;
    if (args[i] === '--force') forceRestart = true;
  }
  return { ...updates, forceWizard, forceRestart };
}

function launchProxyProcess() {
  const child = spawn(process.execPath, [PROXY_SCRIPT], { detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid;
}

function _cleanupFailedProxyStart() {
  const pid = readProxyPid();
  if (pid) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ }
  }
  clearProxyPid();
}

function _printProxyStartFailure(chalk) {
  console.log(chalk.yellow('  Proxy did not start in time.'));
  console.log(`  Try ${chalk.cyan('badgr-auto stop')} then ${chalk.cyan('badgr-auto start')} again.`);
  console.log();
}

export const ROUTING_DEFAULT = 'hybrid';

export const ROUTING_CHOICES = [
  {
    name: 'Local only\n    Use Ollama or LM Studio on this computer — no AI Badgr account required',
    value: 'local',
    short: 'Local only',
  },
  {
    name: 'Local + cloud  (Recommended)\n    Local for tiny tasks → DeepSeek for normal work → Claude Sonnet only when needed. Escalate harder work to OSS or premium models when needed',
    value: 'hybrid',
    short: 'Local + cloud',
  },
  {
    name: 'Direct  (Routing off)\n    Forward all requests straight to your upstream — no tier selection, model unchanged',
    value: 'direct',
    short: 'Direct (routing off)',
  },
];

export const OUTCOME_CHOICES = [
  {
    name: 'Token optimization only  (Recommended)\n    Keep your current models. Remove repeated structured context. Show savings.',
    value: 'token-only',
    short: 'Token optimization only',
  },
  {
    name: 'Everything\n    Token optimization + routing to cheaper models + fallback + optional local models.',
    value: 'everything',
    short: 'Everything',
  },
];

// Outcome → proxy config mapping
export const OUTCOME_MAP = {
  'token-only': { tokenOptimization: true, routingMode: 'direct', savingsStats: true, needsCloud: false, needsLocal: false },
  'everything': { tokenOptimization: true, routingMode: 'hybrid', savingsStats: true, needsCloud: true,  needsLocal: true  },
};

/** Build proxy config updates from wizard outcome settings (exported for tests). */
export function buildWizardProxyUpdates(settings, cliUpdates = {}, { localBaseUrl = '', localModel = '', freshConfig = {} } = {}) {
  const { tokenOptimization, routingMode, savingsStats } = settings;
  const proxyUpdates = { ...cliUpdates, tokenOptimization, routingMode, savingsStats };
  if (localBaseUrl) {
    proxyUpdates.edgeBaseUrl = localBaseUrl;
    proxyUpdates.edgeModel   = localModel;
  }
  if (freshConfig.baseUrl) {
    const upstream = freshConfig.baseUrl.replace(/\/+$/, '');
    proxyUpdates.upstreamBaseUrl = upstream;
    proxyUpdates.midBaseUrl      = upstream;
  }
  return proxyUpdates;
}

export const LOCAL_SERVER_URLS = {
  ollama: 'http://localhost:11434',
  lmstudio: 'http://localhost:1234',
};

export const ONBOARDING_PROMPTS = {
  local: 'Explain what this JavaScript function does.',
  cloud: 'Review this backend architecture for security risks.',
};

function _openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

async function _findFreePort() {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', () => resolve(null));
  });
}

async function _waitForCallbackKey(port, timeoutMs = 60000) {
  if (!port) return null;
  return new Promise((resolve) => {
    let settled = false;
    const done = (key) => {
      if (settled) return;
      settled = true;
      try { server.close(); } catch { /* already closed */ }
      resolve(key);
    };
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url, `http://localhost:${port}`);
        const key = url.searchParams.get('key') || url.searchParams.get('api_key') || url.searchParams.get('token');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem"><h2>&#x2713; Connected to AI Badgr Auto</h2><p>You can close this tab and return to your terminal.</p></body></html>');
        done(key || null);
      } catch { done(null); }
    });
    server.on('error', () => done(null));
    server.listen(port, '127.0.0.1');
    setTimeout(() => done(null), timeoutMs);
  });
}

async function _runLoginFlow(chalk) {
  console.log(`  ${chalk.cyan('https://aibadgr.com/login')}`);
  console.log();
  console.log('  Opening browser…');

  const callbackPort = await _findFreePort();
  const callbackUrl  = callbackPort ? `http://localhost:${callbackPort}/callback` : null;
  const loginUrl     = callbackUrl
    ? `https://aibadgr.com/login?cli_callback=${encodeURIComponent(callbackUrl)}`
    : 'https://aibadgr.com/login';

  _openBrowser(loginUrl);

  let apiKey = null;
  if (callbackPort) {
    process.stdout.write('  Waiting for sign-in');
    const dotInterval = setInterval(() => process.stdout.write('.'), 1500);
    apiKey = await _waitForCallbackKey(callbackPort, 60000);
    clearInterval(dotInterval);
    process.stdout.write('\r' + ' '.repeat(50) + '\r');
  }

  if (!apiKey) {
    try {
      apiKey = await input({
        message: '  Paste your AI Badgr API key (or press Enter to skip):',
      });
    } catch { /* ctrl-c */ }
  }

  if (!apiKey?.trim()) {
    console.log('  Skipped. Run ' + chalk.cyan('badgr-auto login') + ' later to connect your account.');
    console.log();
    return;
  }

  saveConfig({ apiKey: apiKey.trim(), baseUrl: DEFAULTS.baseUrl });
  const saved = loadConfig();
  try {
    const res = await fetch(`${saved.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${saved.apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401 || res.status === 403) {
      console.log(chalk.yellow('  ⚠ API key not accepted. Run badgr-auto login to try again.'));
      return;
    }
  } catch { /* offline — save anyway */ }

  console.log(chalk.green('  ✓ Signed in to AI Badgr'));
  console.log();
}

async function _runWizard(chalk, cliUpdates) {
  console.log();
  console.log(chalk.bold('  Welcome to AI Badgr Auto.'));
  console.log();

  // ── Step 1 — What do you want? ─────────────────────────────────────────
  let outcome = 'token-only';
  try {
    outcome = await select({
      message: 'What do you want?',
      choices: OUTCOME_CHOICES,
      default: 'token-only',
    });
  } catch { /* ctrl-c — use default */ }

  console.log();

  const settings = OUTCOME_MAP[outcome] || OUTCOME_MAP['token-only'];

  // ── Step 2 — Login ─────────────────────────────────────────────────────
  const config = loadConfig();
  if (settings.needsCloud && !config.apiKey) {
    await _runLoginFlow(chalk);
  } else if (config.apiKey) {
    console.log(chalk.green(`  ✓ Signed in (${config.apiKey.slice(0, 8)}…)`));
    console.log();
  }

  // ── Step 3 — Detect environment ────────────────────────────────────────
  let localBaseUrl = '';
  let localModel   = '';

  if (settings.needsLocal) {
    const noLoadFallback = { vramGb: 0, ramGb: 0, cpuCores: 0, recommended: null, systemLoad: { vramUsedPct: 0, ramUsedPct: 0, isHighLoad: false } };
    process.stdout.write('  Checking Ollama…');
    const [servers, hw] = await Promise.all([
      detectLocalServers(),
      (async () => { try { return detectHardware(); } catch { return noLoadFallback; } })(),
    ]);
    process.stdout.write('\r' + ' '.repeat(30) + '\r');

    console.log('  Checking Ollama…');
    console.log('  Checking LM Studio…');
    console.log('  Checking available hardware…');
    console.log();

    if (hw.systemLoad.isHighLoad) {
      console.log(chalk.yellow(`  System load is high (GPU: ${hw.systemLoad.vramUsedPct}%, RAM: ${hw.systemLoad.ramUsedPct}%) — local models skipped.`));
    } else if (servers.length > 0) {
      for (const s of servers) {
        console.log(chalk.green(`  ✓ ${s.name} detected at ${s.url}`));
        if (s.models.length) {
          console.log(`    Models: ${s.models.slice(0, 4).join(', ')}${s.models.length > 4 ? ` +${s.models.length - 4} more` : ''}`);
        }
      }
      console.log();
      const primary = servers[0];
      localBaseUrl  = `${primary.url}/v1`;
      if (primary.models.length) {
        const autoModel = selectBestLocalModel(primary.models, hw.vramGb, hw.ramGb);
        if (autoModel) {
          localModel = autoModel;
          console.log(`  Auto-selected: ${chalk.cyan(localModel)}`);
        } else {
          console.log(chalk.yellow('  No installed model fits your hardware — routing to cloud.'));
          localBaseUrl = '';
        }
      }
    } else {
      console.log(chalk.yellow('  No local model server detected.'));
      if (hw.recommended) {
        console.log(`  To use local models: ${chalk.cyan(`ollama pull ${hw.recommended.name}`)}`);
        console.log(`  ${chalk.dim('https://ollama.com')}`);
      } else {
        console.log(`  Install Ollama: ${chalk.dim('https://ollama.com')}`);
      }
    }
    console.log();
  }

  // ── Step 4 — Show what will happen ─────────────────────────────────────
  const { tokenOptimization, routingMode } = settings;
  console.log('  Your setup:');
  console.log(`    Token optimization: ${chalk.cyan('on')}`);
  if (routingMode === 'hybrid') {
    console.log(`    Routing:            ${chalk.cyan('on — cheapest capable model per request')}`);
    console.log(`    Local models:       ${chalk.cyan(localBaseUrl ? 'on when safe' : 'off (no server detected)')}`);
    console.log(`    Fallback:           ${chalk.cyan('cloud enabled')}`);
  } else {
    console.log(`    Routing:            ${chalk.cyan('off — your models unchanged')}`);
  }
  console.log(`    Savings tracking:   ${chalk.cyan('on')}`);
  console.log();

  // ── Build + save config ─────────────────────────────────────────────────
  const freshConfig = loadConfig();
  saveProxyConfig(buildWizardProxyUpdates(settings, cliUpdates, { localBaseUrl, localModel, freshConfig }));

  // ── Step 5 — Start proxy ────────────────────────────────────────────────
  const pid = launchProxyProcess();
  writeProxyPid(pid);

  process.stdout.write('  Starting proxy…');
  const ready = await waitForProxy(PROXY_PORTS);
  process.stdout.write('\r' + ' '.repeat(30) + '\r');

  if (!ready) {
    _cleanupFailedProxyStart();
    _printProxyStartFailure(chalk);
    return;
  }

  const proxyUrl = getProxyUrl();
  console.log(chalk.green('  Badgr Auto running:'));
  console.log(chalk.cyan(`  ${proxyUrl}`));
  console.log();

  // ── Step 6 — Tool config ────────────────────────────────────────────────
  _printConnectionBlock(chalk, loadConfig());
  const { monitorCommand } = await import('./monitor.js');
  await monitorCommand(chalk);
}

async function _runFastStart(chalk, config, cliUpdates) {
  if (cliUpdates.upstreamBaseUrl) {
    saveProxyConfig(cliUpdates);
  } else if (config.apiKey && config.baseUrl) {
    const upstream = config.baseUrl.replace(/\/+$/, '');
    saveProxyConfig({ upstreamBaseUrl: upstream, midBaseUrl: upstream, ...cliUpdates });
  }
  const pid = launchProxyProcess();
  writeProxyPid(pid);
  await waitForProxy(PROXY_PORTS);
  console.log();
  console.log(chalk.green('  ✓ Badgr Auto running at ' + getProxyUrl()));
  _printConnectionBlock(chalk, config);
  const { monitorCommand } = await import('./monitor.js');
  await monitorCommand(chalk);
}

async function _restartProxy(chalk, cliUpdates) {
  stopCommand(chalk);
  await new Promise(r => setTimeout(r, 400));
  const config = loadConfig();
  await _runFastStart(chalk, config, cliUpdates);
}

export async function startCommand(chalk, args = []) {
  const { forceWizard, forceRestart, ...cliUpdates } = parseArgs(args);

  // ── Already running ────────────────────────────────────────────────────
  if (isProxyRunning()) {
    if (forceRestart) {
      return _restartProxy(chalk, cliUpdates);
    }

    if (forceWizard) {
      stopCommand(chalk);
      return _runWizard(chalk, cliUpdates);
    }

    // Status-aware menu
    console.log(chalk.green(`\n  ✓ Badgr Auto is already running at ${PROXY_URL}\n`));
    console.log('  What do you want to do?');

    let choice;
    try {
      choice = await select({
        message: 'Choose an action:',
        choices: [
          { name: 'Show connection instructions', value: 'instructions' },
          { name: 'Re-run setup wizard',           value: 'wizard' },
          { name: 'Restart proxy',                 value: 'restart' },
          { name: 'Stop proxy',                    value: 'stop' },
        ],
      });
    } catch {
      // user hit ctrl-c
      return;
    }

    if (choice === 'instructions') {
      _printConnectionBlock(chalk, loadConfig());
    } else if (choice === 'wizard') {
      stopCommand(chalk);
      return _runWizard(chalk, cliUpdates);
    } else if (choice === 'restart') {
      return _restartProxy(chalk, cliUpdates);
    } else if (choice === 'stop') {
      stopCommand(chalk);
    }
    return;
  }

  const config = loadConfig();

  // ── Force wizard ───────────────────────────────────────────────────────
  if (forceWizard) {
    return _runWizard(chalk, cliUpdates);
  }

  // ── Non-interactive fast path (CI / scripted) ──────────────────────────
  if (cliUpdates.upstreamBaseUrl || config.apiKey) {
    return _runFastStart(chalk, config, cliUpdates);
  }

  // ── Guided onboarding (first-time user) ───────────────────────────────
  return _runWizard(chalk, cliUpdates);
}

export async function setupCommand(chalk) {
  if (isProxyRunning()) {
    stopCommand(chalk);
  }
  return _runWizard(chalk, {});
}

function _printConnectionBlock(chalk, config) {
  const url = getProxyUrl();
  console.log(`  Proxy URL: ${chalk.cyan(url)}`);
  console.log();
  console.log('  Use these settings in Cline, Continue, Aider, OpenClaw, or any OpenAI-compatible tool:');
  console.log();
  console.log(`    Base URL: ${chalk.cyan(url)}`);
  console.log(`    API Key:  ${chalk.dim(config.apiKey ? `${config.apiKey.slice(0, 8)}...` : '<your AI Badgr API key>')}`);
  console.log(`    Model:    ${chalk.cyan('badgr-auto')}`);
  console.log();
  console.log('  OpenAI SDK:');
  console.log(`    ${chalk.dim('const openai = new OpenAI({ baseURL: \'' + url + '\' });')}`);
  console.log();
  console.log(`  ${chalk.dim('Docs:           https://aibadgr.com/docs/badgr-auto')}`);
  console.log(`  ${chalk.dim('Cline setup:    https://aibadgr.com/docs/cline')}`);
  console.log(`  ${chalk.dim('Continue setup: https://aibadgr.com/docs/continue')}`);
  console.log(`  ${chalk.dim('Aider setup:    https://aibadgr.com/docs/aider')}`);
  console.log(`  ${chalk.dim('OpenClaw setup: https://aibadgr.com/docs/openclaw')}`);
  console.log(`  ${chalk.dim('GitHub:         https://github.com/michaelmanly/badgr-auto')}`);
  console.log();
  console.log(`  ${chalk.dim('badgr-auto stop')}       to shut down`);
  console.log(`  ${chalk.dim('badgr-auto stats')}      to see token savings`);
  console.log(`  ${chalk.dim('badgr-auto stats 7d')}   last 7 days`);
  console.log();
}
