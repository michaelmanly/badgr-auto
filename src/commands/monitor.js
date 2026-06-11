/**
 * Live request monitor — polls the local SQLite log for new rows every second
 * and prints each request as it arrives.
 *
 * Runs until SIGINT (Ctrl+C). The proxy keeps running after the monitor exits.
 */
import os from 'os';
import http from 'http';
import { exec } from 'child_process';
import { promisify } from 'util';
import { loadProxyConfig, readProxyPort } from '../proxy-config.js';
import { readRecentRequests } from '../db.js';

const execAsync = promisify(exec);

// Async GPU hidden until wired
const TIER_LABELS = { edge: 'Local', mid: 'OSS cloud', premium: 'Premium' };

const ERROR_HINTS = {
  401: 'unauthorized', 429: 'rate limited', 500: 'server error',
  502: 'bad gateway', 503: 'service unavailable', 504: 'gateway timeout',
};

const CLIENT_NAMES = {
  cline: 'Cline', continue: 'Continue', aider: 'Aider', cursor: 'Cursor',
  openclaw: 'OpenClaw', autogen: 'AutoGen', crewai: 'CrewAI',
  openwebui: 'Open WebUI', 'open-webui': 'Open WebUI',
};

function toolLabel(row) {
  if (row.client) return CLIENT_NAMES[row.client.toLowerCase()] || row.client;
  const map = { coding: 'AI tool', agent: 'Agent', rag: 'RAG tool', chat: 'Chat' };
  return map[row.client_profile] || 'AI tool';
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  } catch { return '??:??:??'; }
}

function quickCheck(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    try {
      const req = http.get(url, (res) => { res.destroy(); resolve(true); });
      req.on('error', () => resolve(false));
      req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
    } catch { resolve(false); }
  });
}

async function getGpuVram() {
  try {
    const { stdout } = await execAsync(
      'nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits',
      { timeout: 2000 }
    );
    const [used, total] = stdout.trim().split(',').map(s => parseInt(s.trim(), 10));
    if (!isNaN(used) && !isNaN(total) && total > 0) {
      return { usedGB: (used / 1024).toFixed(1), totalGB: (total / 1024).toFixed(1) };
    }
  } catch { /* no GPU available */ }
  return null;
}

function getSysStats() {
  const cpus   = os.cpus().length || 1;
  const load1  = os.loadavg()[0];
  const cpuPct = Math.min(100, Math.round((load1 / cpus) * 100));
  const totalGB = (os.totalmem() / 1024 ** 3).toFixed(1);
  const usedGB  = ((os.totalmem() - os.freemem()) / 1024 ** 3).toFixed(1);
  return { cpuPct, usedGB, totalGB };
}

async function buildStatusStrip(chalk, config) {
  const dot  = (ok) => ok ? chalk.green('●') : chalk.red('●');
  const dim  = chalk.dim;
  const parts = [];

  // LOCAL — ping edge base URL if configured
  if (config.edgeBaseUrl) {
    const url = config.edgeBaseUrl.replace(/\/+$/, '');
    const checkUrl = url.includes('11434') ? `${url}/api/tags` : `${url}/v1/models`;
    const up = await quickCheck(checkUrl);
    parts.push(`${dot(up)} LOCAL ${up ? chalk.green('healthy') : chalk.red('offline')}`);
  }

  // CLOUD — healthy if cloud routing is configured (no external ping needed)
  if (config.routingMode !== 'local' && config.routingMode !== 'direct') {
    parts.push(`${chalk.green('●')} CLOUD ${chalk.green('healthy')}`);
  }

  // PREMIUM — ready if premium model is configured
  if (config.premiumModel) {
    parts.push(`${chalk.green('●')} PREMIUM ${chalk.green('ready')}`);
  }

  // PROXY — we are inside it, so always live
  parts.push(`${chalk.green('●')} PROXY ${chalk.green('live')}`);

  return '  ' + parts.join(dim('   '));
}

function printRow(chalk, row, gpu) {
  const tier  = TIER_LABELS[row.route_tier] || row.route_tier || 'unknown';
  const tool  = toolLabel(row);
  const saved = (row.original_tokens || 0) - (row.optimized_tokens || 0);
  const pct   = row.original_tokens > 0 ? Math.round((saved / row.original_tokens) * 100) : 0;
  const isError = (row.status_code || 200) >= 400;
  const isSlow  = row.latency_target_ms && row.latency_ms > row.latency_target_ms;
  const preferredLabel = TIER_LABELS[row.preferred_tier] || row.preferred_tier;
  const routeDisplay = row.route_fallback_used && preferredLabel && preferredLabel !== tier
    ? `${preferredLabel} → ${tier}`
    : tier;

  // ── Headline ─────────────────────────────────────────────────────────────
  const statusIcon = isError ? chalk.red('✗') : chalk.green('✓');
  const latencyFlag = isSlow ? chalk.yellow(' ⚠') : '';
  const savedStr = (row.estimated_savings_vs_sonnet || 0) > 0
    ? chalk.green(`est. saved $${(row.estimated_savings_vs_sonnet).toFixed(3)} vs Sonnet`)
    : pct > 0
      ? chalk.green(`${pct}% removed`)
      : '';

  const parts = [
    chalk.bold(`#${row.id}`),
    chalk.dim(fmtTime(row.created_at)),
    chalk.cyan(tool),
    chalk.yellow(routeDisplay),
    `${fmtTokens(row.original_tokens)}→${fmtTokens(row.optimized_tokens)}`,
    savedStr,
    `${row.latency_ms || 0}ms${latencyFlag}`,
    statusIcon,
  ].filter(Boolean);

  console.log();
  console.log('  ' + parts.join('  '));

  // ── Routing detail (only when interesting) ────────────────────────────────
  if (row.route_reason || isError || row.route_fallback_used) {
    if (row.route_reason) {
      console.log(chalk.dim(`  Why this route:  `) + row.route_reason);
    }
    if (row.route_fallback_used && preferredLabel && preferredLabel !== tier) {
      console.log(chalk.dim(`  Fallback:        `) + chalk.yellow(`${preferredLabel} unavailable → used ${tier}`));
    }
    if (isError) {
      const hint = ERROR_HINTS[row.status_code] || '';
      console.log(chalk.dim(`  Error:           `) + chalk.red(`${row.status_code}${hint ? ' — ' + hint : ''}`));
    }
  }
  if (row.context_used_percent != null && row.context_used_percent >= 60) {
    const pctStr = `${row.context_used_percent.toFixed(1)}%`;
    const msg = row.context_used_percent >= 75
      ? chalk.red(`  ⚠ Context: ${pctStr} used — compact now`)
      : chalk.yellow(`  ⚠ Context: ${pctStr} used — compact soon`);
    console.log(msg);
  }

  // ── System stats (secondary) ──────────────────────────────────────────────
  const sys = getSysStats();
  const sysLine = [`CPU ${sys.cpuPct}%`, `RAM ${sys.usedGB}/${sys.totalGB}GB`];
  if (gpu) sysLine.push(`GPU ${gpu.usedGB}/${gpu.totalGB}GB`);
  console.log(chalk.dim('  ' + sysLine.join('  ')));
}

async function printHeader(chalk, config) {
  const proxyUrl  = `http://localhost:${readProxyPort()}/v1`;
  const modeLabel = config.routingMode === 'local' ? 'Local only'
    : config.routingMode === 'direct' ? 'Direct (routing off)'
    : 'Balanced';

  console.log();
  console.log(chalk.bold('  AI Badgr Auto') + chalk.dim(' — live request monitor'));
  console.log(`  Proxy: ${chalk.cyan(proxyUrl)}   Mode: ${modeLabel}`);
  if (config.edgeModel) console.log(chalk.dim(`  Local: ${config.edgeModel}`));
  if (config.midModel && config.routingMode !== 'local') {
    console.log(chalk.dim(`  Cloud: ${config.midModel} → ${config.premiumModel || 'Claude Sonnet'} fallback`));
  }
  console.log();

  // Status strip
  const strip = await buildStatusStrip(chalk, config);
  console.log(strip);
  console.log();
  console.log(chalk.bold('  LIVE REQUESTS'));
  console.log(chalk.dim('  #id  time      tool      route       tokens      est. savings   latency'));
  console.log('  ' + '─'.repeat(72));
}

export async function monitorCommand(chalk) {
  const config = loadProxyConfig();

  // Check GPU once at startup; pass result to each row printer
  const gpu = await getGpuVram();

  await printHeader(chalk, config);

  let lastId = 0;
  try {
    const existing = await readRecentRequests({ limit: 1 });
    if (existing.length > 0) lastId = existing[0].id || 0;
  } catch { /* start from 0 */ }

  if (lastId === 0) {
    console.log(chalk.dim('  Waiting for requests… send a message in Cline, Continue, or Aider.'));
  } else {
    console.log(chalk.dim(`  Showing new requests (${lastId} previously logged). Press Ctrl+C to exit.`));
  }

  process.on('SIGINT', () => {
    console.log();
    console.log(chalk.dim('  Monitor stopped. Proxy is still running.'));
    console.log(chalk.dim(`  Run ${chalk.cyan('badgr-auto stats')} to see savings summary.`));
    console.log();
    process.exit(0);
  });

  async function poll() {
    try {
      const rows = await readRecentRequests({ limit: 50 });
      const newRows = rows.filter(r => (r.id || 0) > lastId).sort((a, b) => (a.id || 0) - (b.id || 0));
      for (const row of newRows) {
        printRow(chalk, row, gpu);
        lastId = Math.max(lastId, row.id || 0);
      }
    } catch { /* db not ready yet */ }
    setTimeout(poll, 1000);
  }

  setTimeout(poll, 1000);

  await new Promise(() => { /* resolved only by SIGINT */ });
}
