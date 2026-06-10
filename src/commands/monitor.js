/**
 * Live request monitor — polls the local SQLite log for new rows every second
 * and prints each request as it arrives.
 *
 * Runs until SIGINT (Ctrl+C). The proxy keeps running after the monitor exits.
 */
import { loadProxyConfig, PROXY_PORT } from '../proxy-config.js';
import { readRecentRequests, REQUEST_LOG_DB } from '../db.js';

const TIER_LABELS = { edge: 'Local', mid: 'OSS cloud', async: 'Async GPU', premium: 'Premium' };

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

function printRow(chalk, row) {
  const tier = TIER_LABELS[row.route_tier] || row.route_tier || 'unknown';
  const tool = toolLabel(row);
  const saved = (row.original_tokens || 0) - (row.optimized_tokens || 0);
  const pct = row.original_tokens > 0 ? Math.round((saved / row.original_tokens) * 100) : 0;
  const isError = (row.status_code || 200) >= 400;
  const status = isError
    ? chalk.red(`error ${row.status_code}`)
    : row.streaming ? 'streaming' : 'completed';
  const isSlowRequest = row.latency_target_ms && row.latency_ms > row.latency_target_ms;
  const preferredLabel = TIER_LABELS[row.preferred_tier] || row.preferred_tier;
  const routeDisplay = row.route_fallback_used && preferredLabel && preferredLabel !== tier
    ? `${preferredLabel} → ${tier}`
    : tier;

  console.log();
  console.log(chalk.bold(`  #${row.id}`) + chalk.dim(`  ${fmtTime(row.created_at)}`) + `  ${chalk.cyan(tool)}`);
  console.log(`  Status:           ${status}`);
  if (isError && ERROR_HINTS[row.status_code]) {
    console.log(`  Error:            ${chalk.red(ERROR_HINTS[row.status_code])}`);
  }
  console.log(`  Route:            ${routeDisplay}`);
  console.log(`  Model:            ${row.model || '—'}`);
  if (row.route_reason) console.log(`  Reason:           ${row.route_reason}`);
  console.log(`  Tokens:           ${fmtTokens(row.original_tokens)} → ${fmtTokens(row.optimized_tokens)}`);
  if (saved > 0) console.log(`  Saved:            ${chalk.green(`${fmtTokens(saved)} tokens (${pct}%)`)}`);
  console.log(`  Actual cost:      ${chalk.green(`$${(row.actual_cost_usd || 0).toFixed(4)}`)}`);
  if ((row.estimated_savings_vs_sonnet || 0) > 0) {
    console.log(`  Saved vs Sonnet:  ${chalk.green(`$${(row.estimated_savings_vs_sonnet).toFixed(4)}`)}`);
  }
  const latencyStr = isSlowRequest
    ? `${row.latency_ms}ms  ${chalk.yellow('⚠ slower than target')}`
    : `${row.latency_ms}ms`;
  console.log(`  Latency:          ${latencyStr}`);
}

function printHeader(chalk, config) {
  const proxyUrl = `http://localhost:${PROXY_PORT}/v1`;
  const modeLabel = config.routingMode === 'local' ? 'Local only'
    : config.routingMode === 'direct' ? 'Direct (routing off)'
    : 'Balanced';
  const edgeModel = config.edgeModel || '—';
  const midModel  = config.midModel  || '—';

  console.log();
  console.log(chalk.bold('  AI Badgr Auto'));
  console.log(`  Proxy: ${chalk.cyan(proxyUrl)}`);
  console.log(`  Mode:  ${modeLabel}`);
  if (config.edgeBaseUrl) console.log(`  Local: ${edgeModel}`);
  if (config.routingMode !== 'local') console.log(`  Cloud: ${midModel} → ${config.premiumModel || 'Claude Sonnet'} fallback`);
  console.log();
  console.log(chalk.bold('  LIVE REQUESTS'));
  console.log('  ' + '─'.repeat(48));
}

export async function monitorCommand(chalk) {
  const config = loadProxyConfig();
  printHeader(chalk, config);

  // Seed lastId from the current max so we only show NEW requests.
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

  // Poll every second for new rows.
  async function poll() {
    try {
      const rows = await readRecentRequests({ limit: 50 });
      const newRows = rows.filter(r => (r.id || 0) > lastId).sort((a, b) => (a.id || 0) - (b.id || 0));
      for (const row of newRows) {
        printRow(chalk, row);
        lastId = Math.max(lastId, row.id || 0);
      }
    } catch { /* db not ready yet */ }
    setTimeout(poll, 1000);
  }

  setTimeout(poll, 1000);

  // Keep process alive.
  await new Promise(() => { /* resolved only by SIGINT */ });
}
