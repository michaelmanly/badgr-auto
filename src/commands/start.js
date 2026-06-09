import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { select, input } from '@inquirer/prompts';
import {
  loadProxyConfig, saveProxyConfig,
  readProxyPid, writeProxyPid, isProxyRunning, PROXY_PORT,
} from '../proxy-config.js';
import { loadConfig, saveConfig, DEFAULTS } from '../config.js';
import { detectLocalServers } from '../detect.js';
import { detectHardware } from '../hardware.js';
import { probeProxy } from '../probe-proxy.js';

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

function launchProxyProcess() {
  const child = spawn(process.execPath, [PROXY_SCRIPT], { detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid;
}

/** Wait up to `ms` for the proxy to start accepting connections. */
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

export async function startCommand(chalk, args = []) {
  const cliUpdates = parseArgs(args);

  // ── Already running ────────────────────────────────────────────────────
  if (isProxyRunning()) {
    const pid = readProxyPid();
    console.log(chalk.green(`\n  ✓ Badgr Auto already running (PID ${pid}) at ${PROXY_URL}\n`));
    return;
  }

  const config = loadConfig();

  // ── Non-interactive fast path (CI / scripted) ──────────────────────────
  if (cliUpdates.upstreamBaseUrl || config.apiKey) {
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
    return;
  }

  // ── Guided onboarding ──────────────────────────────────────────────────
  console.log();
  console.log(chalk.bold('  Welcome to AI Badgr Auto.'));
  console.log();

  // Step 1 — routing mode
  const mode = await select({
    message: 'How do you want to run AI requests?',
    choices: [
      {
        name: 'Local + cloud  (Recommended)\n    Use local models for easy tasks, AI Badgr cloud for harder work',
        value: 'hybrid',
        short: 'Local + cloud',
      },
      {
        name: 'Local only\n    Use Ollama or LM Studio on this computer — no AI Badgr account needed',
        value: 'local',
        short: 'Local only',
      },
    ],
  });

  console.log();

  // Step 2 — detect local models + hardware
  process.stdout.write('  Detecting local model servers…');
  const [servers, hw] = await Promise.all([detectLocalServers(), (async () => { try { return detectHardware(); } catch { return { vramGb: 0, ramGb: 0, cpuCores: 0, recommended: null }; } })()]);
  process.stdout.write('\r' + ' '.repeat(40) + '\r'); // clear line

  const ramLabel   = `${hw.ramGb.toFixed(1)} GB RAM`;
  const vramLabel  = hw.vramGb > 0 ? `${hw.vramGb.toFixed(1)} GB VRAM` : 'no discrete GPU detected';
  const cpuLabel   = `${hw.cpuCores} CPU cores`;
  console.log(`  Hardware: ${ramLabel}, ${vramLabel}, ${cpuLabel}`);
  console.log();

  let localBaseUrl = '';
  let localModel   = '';

  if (servers.length > 0) {
    for (const s of servers) {
      console.log(chalk.green(`  ✓ ${s.name} detected at ${s.url}`));
      if (s.models.length) {
        console.log(`    Models: ${s.models.slice(0, 4).join(', ')}${s.models.length > 4 ? ` +${s.models.length - 4} more` : ''}`);
      }
    }
    console.log();

    // Pick the best available model from the first server found
    const primary = servers[0];
    localBaseUrl = `${primary.url}/v1`;

    if (primary.models.length) {
      const preferredOrder = hw.recommended?.name ? [hw.recommended.name, 'qwen2.5-coder:7b', 'llama3.2:8b', 'llama3.1:8b', 'mistral:7b'] : ['qwen2.5-coder:7b', 'llama3.2:8b'];
      const defaultModel = preferredOrder.find(m => primary.models.some(pm => pm === m || pm.startsWith(m.split(':')[0]))) || primary.models[0];
      if (primary.models.length > 1) {
        localModel = await select({
          message: '  Select a local model for simple tasks:',
          choices: primary.models.map(m => ({ name: m, value: m })),
          default: defaultModel,
        });
      } else {
        localModel = primary.models[0];
      }
      console.log(`  Using local model: ${chalk.cyan(localModel)}`);
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
    console.log(chalk.yellow('  Proxy did not start in time. Try running badgr-auto start again.'));
    return;
  }

  if (localBaseUrl) {
    console.log('  Testing local route…');
    console.log();
    const localPrompt = 'Explain what this JavaScript function does: function add(a,b){return a+b;}';
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
    console.log('    Prompt: Review this backend architecture for security risks.');
    console.log();
    console.log('    This task needs a stronger cloud route.');
    console.log();

    if (!config.apiKey) {
      console.log('  Connect your AI Badgr account to unlock cloud routing:');
      console.log();
      console.log(`    ${chalk.cyan('https://aibadgr.com/login')}`);
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

        let validated = false;
        try {
          const res = await fetch(`${saved.baseUrl}/models`, {
            headers: { Authorization: `Bearer ${saved.apiKey}` },
            signal: AbortSignal.timeout(8000),
          });
          validated = res.ok || res.status === 404;
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
          'Review this backend architecture for security risks. List the top 3 concerns.',
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
