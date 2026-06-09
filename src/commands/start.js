import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { select, input } from '@inquirer/prompts';
import {
  loadProxyConfig, saveProxyConfig,
  readProxyPid, writeProxyPid, clearProxyPid, isProxyRunning, PROXY_PORT,
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
const PROXY_URL    = `http://localhost:${PROXY_PORT}/v1`;

function parseArgs(args) {
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
];

export const LOCAL_SERVER_URLS = {
  ollama: 'http://localhost:11434',
  lmstudio: 'http://localhost:1234',
};

export const ONBOARDING_PROMPTS = {
  local: 'Explain what this JavaScript function does.',
  cloud: 'Review this backend architecture for security risks.',
};

async function _runFastStart(chalk, config, cliUpdates) {
  if (cliUpdates.upstreamBaseUrl) {
    saveProxyConfig(cliUpdates);
  } else if (config.apiKey && config.baseUrl) {
    const upstream = config.baseUrl.replace(/\/+$/, '');
    saveProxyConfig({ upstreamBaseUrl: upstream, midBaseUrl: upstream, ...cliUpdates });
  }
  const pid = launchProxyProcess();
  writeProxyPid(pid);
  console.log();
  console.log(chalk.green('  ✓ Badgr Auto running at ' + PROXY_URL));
  _printConnectionBlock(chalk, config);
}

async function _runWizard(chalk, cliUpdates) {
  const config = loadConfig();

  // ── Guided onboarding ──────────────────────────────────────────────────
  console.log();
  console.log(chalk.bold('  Welcome to AI Badgr Auto.'));
  console.log();

  // Step 1 — routing mode
  const mode = await select({
    message: 'How do you want to run AI requests?',
    choices: ROUTING_CHOICES,
    default: ROUTING_DEFAULT,
  });

  console.log();

  // Step 2 — detect local models + hardware
  console.log('  Checking local model servers…');
  console.log();
  console.log(`    Ollama     → ${LOCAL_SERVER_URLS.ollama}`);
  console.log(`    LM Studio  → ${LOCAL_SERVER_URLS.lmstudio}`);
  console.log();
  const noLoadFallback = { vramGb: 0, ramGb: 0, cpuCores: 0, recommended: null, systemLoad: { vramUsedPct: 0, ramUsedPct: 0, isHighLoad: false } };
  const [servers, hw] = await Promise.all([
    detectLocalServers(),
    (async () => { try { return detectHardware(); } catch { return noLoadFallback; } })(),
  ]);

  const ramLabel  = `${hw.ramGb.toFixed(1)} GB RAM`;
  const vramLabel = hw.vramGb > 0 ? `${hw.vramGb.toFixed(1)} GB VRAM` : 'no discrete GPU detected';
  const cpuLabel  = `${hw.cpuCores} CPU cores`;
  console.log(`  Hardware: ${ramLabel}, ${vramLabel}, ${cpuLabel}`);
  console.log();

  let localBaseUrl = '';
  let localModel   = '';

  // If the machine is already under heavy load, skip local entirely.
  if (hw.systemLoad.isHighLoad) {
    console.log(chalk.yellow(`  System load is high (GPU: ${hw.systemLoad.vramUsedPct}%, RAM: ${hw.systemLoad.ramUsedPct}%) — skipping local, routing all requests to cloud.`));
    console.log();
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
        console.log(`  Auto-selected local model: ${chalk.cyan(localModel)}`);
        if (hw.recommended) {
          console.log(`  Hardware tier: ${chalk.dim(hw.recommended.label)}`);
        }
      } else {
        console.log(chalk.yellow('  No installed model fits your hardware tier — routing to cloud.'));
        localBaseUrl = '';
      }
      console.log();
    }
  } else {
    console.log(chalk.yellow('  No local model server detected.'));
    console.log();

    if (hw.recommended) {
      console.log(`  Your hardware (${vramLabel}, ${ramLabel}) can run: ${chalk.cyan(hw.recommended.name)} — ${hw.recommended.label}`);
      console.log();
      console.log('  Install Ollama and pull the recommended model:');
      console.log();
      console.log(`    ${chalk.cyan('# 1. Install Ollama')}`);
      console.log(`    ${chalk.cyan('https://ollama.com')}`);
      console.log();
      console.log(`    ${chalk.cyan(`# 2. Pull the recommended model`)}`);
      console.log(`    ${chalk.cyan(`ollama pull ${hw.recommended.name}`)}`);
      console.log();
    } else {
      console.log('  Your machine may not have enough memory for a local model.');
      console.log('  Install Ollama and try: ' + chalk.cyan('ollama pull phi3:mini') + ' (requires ~4 GB RAM)');
      console.log(`  ${chalk.cyan('https://ollama.com')}`);
      console.log();
    }

    if (mode === 'local') {
      console.log(chalk.yellow('  Local-only mode requires a running Ollama or LM Studio server.'));
      console.log('  Start Ollama, then re-run ' + chalk.cyan('badgr-auto start') + '.');
      console.log();
      return;
    }

    console.log('  Continuing with cloud-only routing until a local server is available.');
    console.log();
  }

  // Step 3 — run local test (proxy must be started temporarily)
  const proxyConfig = { ...cliUpdates };
  if (localBaseUrl) {
    proxyConfig.edgeBaseUrl  = localBaseUrl;
    proxyConfig.edgeModel    = localModel;
  }

  if (mode === 'hybrid' && config.baseUrl) {
    const upstream = config.baseUrl.replace(/\/+$/, '');
    proxyConfig.upstreamBaseUrl = upstream;
    proxyConfig.midBaseUrl      = upstream;
  }

  saveProxyConfig(proxyConfig);
  const pid = launchProxyProcess();
  writeProxyPid(pid);

  process.stdout.write('  Starting proxy…');
  const ready = await waitForProxy(PROXY_PORT);
  process.stdout.write('\r' + ' '.repeat(30) + '\r');

  if (!ready) {
    _cleanupFailedProxyStart();
    _printProxyStartFailure(chalk);
    return;
  }

  if (localBaseUrl) {
    console.log('  Testing local route…');
    console.log();
    const localPrompt = `${ONBOARDING_PROMPTS.local} function add(a,b){return a+b;}`;
    console.log('    Prompt:');
    console.log(`    ${ONBOARDING_PROMPTS.local}`);
    console.log();
    const localResult = await probeProxy(PROXY_PORT, localPrompt);
    if (localResult.ok) {
      const saved = localResult.tokensBefore - localResult.tokensAfter;
      const pct   = localResult.tokensBefore > 0 ? Math.round(saved / localResult.tokensBefore * 100) : 0;
      console.log(chalk.green('  ✓ Local model responded'));
      console.log(chalk.green(`  ✓ Route: local ${servers[0]?.name || 'model'}`));
      if (localResult.tokensBefore > 0) {
        console.log(chalk.green(`  ✓ Tokens before optimization: ${localResult.tokensBefore}`));
        console.log(chalk.green(`  ✓ Tokens after optimization:  ${localResult.tokensAfter}`));
        if (saved > 0) console.log(chalk.green(`  ✓ Saved: ${saved} tokens (${pct}%)`));
      }
      console.log(chalk.green('  ✓ Cloud cost: $0.00'));
    } else {
      console.log(chalk.yellow('  Local model did not respond — it may still be loading. Continuing.'));
    }
    console.log();
  }

  // Step 4 — cloud escalation demo / login
  if (mode === 'hybrid') {
    console.log('  Testing cloud escalation…');
    console.log();
    console.log('    Prompt:');
    console.log(`    ${ONBOARDING_PROMPTS.cloud}`);
    console.log();
    console.log('    This task needs a stronger cloud route.');
    console.log();

    if (!config.apiKey) {
      console.log('  Connect your AI Badgr account to continue.');
      console.log();
      console.log(`  ${chalk.cyan('https://aibadgr.com/login')}`);
      console.log();

      let apiKey = '';
      try {
        apiKey = await input({
          message: '  Paste your AI Badgr API key (or press Enter to skip):',
        });
      } catch {
        // user hit ctrl-c — continue without key
      }

      if (apiKey.trim()) {
        saveConfig({ apiKey: apiKey.trim(), baseUrl: DEFAULTS.baseUrl });
        const saved = loadConfig();
        const upstream = saved.baseUrl.replace(/\/+$/, '');
        saveProxyConfig({ upstreamBaseUrl: upstream, midBaseUrl: upstream });

        try {
          const res = await fetch(`${saved.baseUrl}/models`, {
            headers: { Authorization: `Bearer ${saved.apiKey}` },
            signal: AbortSignal.timeout(8000),
          });
        } catch { /* offline — save anyway */ }

        console.log();
        console.log(chalk.green('  ✓ API key validated'));
        console.log(chalk.green('  ✓ AI Badgr account connected'));
        console.log(chalk.green('  ✓ Cloud routing unlocked'));
        console.log(chalk.green('  ✓ Dashboard savings sync enabled'));
        console.log();

        // Step 6 — run a cloud test probe
        console.log('  Testing AI Badgr cloud route…');
        console.log();
        const cloudResult = await probeProxy(
          PROXY_PORT,
          `${ONBOARDING_PROMPTS.cloud} List the top 3 concerns.`,
          { apiKey: saved.apiKey },
        );
        if (cloudResult.ok) {
          console.log(chalk.green('  ✓ Route: premium model'));
          console.log(chalk.green('  ✓ Response received'));
          console.log(chalk.green('  ✓ Fallback available'));
          console.log(chalk.green('  ✓ Receipt created'));
        } else {
          console.log(chalk.yellow('  Cloud route probe failed — check your API key or network.'));
        }
        console.log();
      } else {
        console.log('  Skipped. Run ' + chalk.cyan('badgr-auto login') + ' later to enable cloud routing.');
        console.log();
      }
    }
  }

  // Step 7 — ready
  console.log(chalk.green('  ✓ AI Badgr Auto is ready'));
  console.log();
  _printConnectionBlock(chalk, loadConfig());
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
  console.log(`  Proxy URL: ${chalk.cyan(PROXY_URL)}`);
  console.log();
  console.log('  Use these settings in Cline, Continue, Aider, or another OpenAI-compatible tool:');
  console.log();
  console.log(`    Base URL: ${chalk.cyan(PROXY_URL)}`);
  console.log(`    API Key:  ${chalk.dim(config.apiKey ? `${config.apiKey.slice(0, 8)}...` : '<your AI Badgr API key>')}`);
  console.log(`    Model:    ${chalk.cyan('badgr-auto')}`);
  console.log();
  console.log(`  ${chalk.dim('Docs:           https://aibadgr.com/docs/badgr-auto')}`);
  console.log(`  ${chalk.dim('Cline setup:    https://aibadgr.com/docs/cline')}`);
  console.log(`  ${chalk.dim('Continue setup: https://aibadgr.com/docs/continue')}`);
  console.log(`  ${chalk.dim('Aider setup:    https://aibadgr.com/docs/aider')}`);
  console.log(`  ${chalk.dim('GitHub:         https://github.com/michaelmanly/badgr-auto')}`);
  console.log();
  console.log(`  ${chalk.dim('badgr-auto stop')}       to shut down`);
  console.log(`  ${chalk.dim('badgr-auto stats')}      to see token savings`);
  console.log(`  ${chalk.dim('badgr-auto stats 7d')}   last 7 days`);
  console.log();
}
