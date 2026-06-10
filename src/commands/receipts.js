/**
 * badgr-auto receipts          — list last 20 requests
 * badgr-auto receipt <id>      — show one request
 */
import { readRecentRequests, readRequestById } from '../db.js';

const TIER_LABELS = { edge: 'Local', mid: 'OSS cloud', async: 'Async GPU', premium: 'Premium' };

const CHARGE_STATUS_LABELS = {
  not_charged: 'Not charged',
  potentially_charged: 'Potentially charged',
  confirmed_usage_reported: 'Confirmed usage reported',
  unknown: 'Unknown',
};

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

function fmtTime(iso) {
  try { return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }); }
  catch { return '??:??'; }
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function col(label, value, width = 28) {
  return `  ${label.padEnd(width)}${value}`;
}

export async function receiptsCommand(chalk, args = []) {
  const periodArg = args.find(a => /^\d+d$/.test(a));
  const period = periodArg || 'all';
  const filterFailed   = args.includes('--failed');
  const filterFallback = args.includes('--fallback');

  let rows;
  try {
    rows = await readRecentRequests({ limit: 20, period, failed: filterFailed, fallback: filterFallback });
  } catch (err) {
    console.error(chalk.red(`\n  Could not read receipts: ${err.message}\n`));
    process.exitCode = 1;
    return;
  }

  if (!rows.length) {
    console.log(chalk.dim('\n  No requests logged yet.'));
    console.log(chalk.dim('  Run badgr-auto start and send some requests through Cline, Continue, or Aider.\n'));
    return;
  }

  const filterLabel = filterFailed ? ' (errors only)' : filterFallback ? ' (fallbacks only)' : '';
  console.log();
  console.log(chalk.bold(`  Recent requests${filterLabel}`));
  console.log('  ' + '─'.repeat(72));
  console.log(chalk.dim('  Time   Tool          Route          Saved     Cost      Status'));
  console.log('  ' + '─'.repeat(72));

  for (const row of rows) {
    const tier   = TIER_LABELS[row.route_tier] || row.route_tier || '—';
    const tool   = toolLabel(row).padEnd(12);
    const saved  = row.original_tokens > 0
      ? `${Math.round(((row.original_tokens - row.optimized_tokens) / row.original_tokens) * 100)}%`
      : '—';
    const cost   = `$${(row.actual_cost_usd || 0).toFixed(4)}`;
    const isError = (row.status_code || 200) >= 400;
    const status = row.route_fallback_used
      ? 'fallback'
      : isError
        ? chalk.red(`err ${row.status_code}`)
        : 'ok';
    const idStr  = chalk.dim(`#${row.id}`).padEnd(8);
    console.log(`  ${fmtTime(row.created_at)}  ${chalk.cyan(tool)}  ${tier.padEnd(12)}   ${saved.padEnd(8)}  ${cost.padEnd(8)}  ${status}   ${idStr}`);
  }

  console.log();
  console.log(chalk.dim(`  Run ${chalk.cyan('badgr-auto receipt <id>')} for full details.`));
  console.log();
}

export async function receiptCommand(chalk, args = []) {
  const doExport = args.includes('--export');
  const rawId = args.find(a => /^\d+$/.test(a));
  if (!rawId) {
    console.error(chalk.red('\n  Usage: badgr-auto receipt <id> [--export]\n'));
    console.log(chalk.dim(`  Get an id from ${chalk.cyan('badgr-auto receipts')}\n`));
    process.exitCode = 1;
    return;
  }

  let row;
  try {
    row = await readRequestById(Number(rawId));
  } catch (err) {
    console.error(chalk.red(`\n  Could not read receipt: ${err.message}\n`));
    process.exitCode = 1;
    return;
  }

  if (!row) {
    console.error(chalk.red(`\n  Request #${rawId} not found.\n`));
    process.exitCode = 1;
    return;
  }

  const tier          = TIER_LABELS[row.route_tier] || row.route_tier || '—';
  const preferredLabel = TIER_LABELS[row.preferred_tier] || row.preferred_tier;
  const routeDisplay  = row.route_fallback_used && preferredLabel && preferredLabel !== tier
    ? `${preferredLabel} → ${tier}`
    : tier;
  const tool          = toolLabel(row);
  const saved         = (row.original_tokens || 0) - (row.optimized_tokens || 0);
  const isError       = (row.status_code || 200) >= 400;
  const isSlowRequest = row.latency_target_ms && row.latency_ms > row.latency_target_ms;
  const chargeLabel   = CHARGE_STATUS_LABELS[row.charge_status] || row.charge_status || '—';

  if (doExport) {
    const lines = [
      `# Badgr Auto Support Bundle — Request #${row.id}`,
      `Generated: ${new Date().toISOString()}`,
      '',
      '## Request Details',
      `ID:                    ${row.id}`,
      `Created:               ${row.created_at || '—'}`,
      `Tool:                  ${tool}`,
      `Model:                 ${row.model || '—'}`,
      `Route:                 ${routeDisplay}`,
      `Route reason:          ${row.route_reason || '—'}`,
      '',
      '## Tokens',
      `Input tokens:          ${row.original_tokens || 0}`,
      `Optimized tokens:      ${row.optimized_tokens || 0}`,
      `Output tokens:         ${row.output_tokens_received || 0}`,
      `Cached tokens:         ${row.cached_tokens || 0}`,
      '',
      '## Timing',
      `Started at:            ${row.started_at || '—'}`,
      `Ended at:              ${row.ended_at || '—'}`,
      `Latency:               ${row.latency_ms || 0}ms`,
      '',
      '## Request Outcome',
      `Status code:           ${row.status_code || '—'}`,
      `Stream completed:      ${row.stream_completed ? 'yes' : 'no'}`,
      `Client disconnected:   ${row.client_disconnected ? 'yes' : 'no'}`,
      `Timed out:             ${row.timed_out ? 'yes' : 'no'}`,
      `Provider usage sent:   ${row.provider_usage_reported ? 'yes' : 'no'}`,
      `Charge status:         ${chargeLabel}`,
      '',
      '## Provider Metadata',
      `Provider request ID:   ${row.provider_request_id || '—'}`,
      `Actual route:          ${row.actual_route || '—'}`,
      '',
      '## Cost',
      `Actual cost:           $${(row.actual_cost_usd || 0).toFixed(6)}`,
      `Saved vs Sonnet:       $${(row.estimated_savings_vs_sonnet || 0).toFixed(6)}`,
    ];
    console.log(lines.join('\n'));
    return;
  }

  console.log();
  console.log(chalk.bold(`  Request #${row.id}`));
  console.log();
  console.log(col('Tool:', tool));
  console.log(col('Route:', routeDisplay));
  console.log(col('Model:', row.model || '—'));
  if (row.route_reason) console.log(col('Why:', row.route_reason));
  if (isError) {
    const hint = ERROR_HINTS[row.status_code] ? ` — ${ERROR_HINTS[row.status_code]}` : '';
    console.log(col('Status:', chalk.red(`error ${row.status_code}${hint}`)));
  }
  console.log(col('Tokens:', `${fmtTokens(row.original_tokens)} → ${fmtTokens(row.optimized_tokens)}`));
  if (saved > 0) console.log(col('Saved:', `${chalk.green(fmtTokens(saved))} tokens`));
  const latencyDisplay = isSlowRequest ? `${row.latency_ms}ms  ⚠ slower than target` : `${row.latency_ms}ms`;
  console.log(col('Latency:', latencyDisplay));
  console.log(col('Actual cost:', chalk.green(`$${(row.actual_cost_usd || 0).toFixed(4)}`)));
  if ((row.estimated_savings_vs_sonnet || 0) > 0) {
    console.log(col('Saved vs Sonnet:', chalk.green(`$${(row.estimated_savings_vs_sonnet).toFixed(4)}`)));
  }
  if (row.charge_status) {
    const isChargeConcern = row.charge_status === 'potentially_charged' || row.charge_status === 'unknown';
    const chargeDisplay = isChargeConcern ? chalk.yellow(chargeLabel) : chargeLabel;
    console.log(col('Charge status:', chargeDisplay));
  }
  if (row.provider_request_id) console.log(col('Provider request ID:', row.provider_request_id));
  console.log();
}
