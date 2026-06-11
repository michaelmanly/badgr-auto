/**
 * badgr-auto receipts          — list last 20 requests
 * badgr-auto receipt <id>      — show one request (forensic detail)
 */
import { readRecentRequests, readRequestById } from '../db.js';

// Async GPU hidden until wired
const TIER_LABELS = { edge: 'Local', mid: 'OSS cloud', premium: 'Premium' };

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

function whyNotLocal(row) {
  if (row.route_tier === 'edge') return null;
  const tokens = row.original_tokens || 0;
  if (tokens > 8000) return `context too large (${fmtTokens(tokens)} tokens)`;
  if (tokens > 4000) return `context size (${fmtTokens(tokens)} tokens)`;
  return 'local model unavailable or routing off';
}

function whyNotPremium(row) {
  if (row.route_tier === 'premium') return null;
  if (row.route_tier === 'edge') return 'local model handled it';
  return 'OSS model was sufficient';
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
  console.log('  ' + '─'.repeat(76));
  console.log(chalk.dim('  Time   Tool          Route          Tokens           Est. saved vs Sonnet  Status'));
  console.log('  ' + '─'.repeat(76));

  for (const row of rows) {
    const tier    = TIER_LABELS[row.route_tier] || row.route_tier || '—';
    const tool    = toolLabel(row).padEnd(12);
    const tokLine = `${fmtTokens(row.original_tokens)}→${fmtTokens(row.optimized_tokens)}`.padEnd(16);
    const savedVS = (row.estimated_savings_vs_sonnet || 0) > 0
      ? chalk.green(`$${(row.estimated_savings_vs_sonnet).toFixed(4)}`)
      : chalk.dim('—');
    const isError  = (row.status_code || 200) >= 400;
    const status   = row.route_fallback_used
      ? chalk.yellow('fallback')
      : isError
        ? chalk.red(`err ${row.status_code}`)
        : chalk.green('ok');
    const idStr = chalk.dim(`#${row.id}`);
    console.log(`  ${fmtTime(row.created_at)}  ${chalk.cyan(tool)}  ${tier.padEnd(12)}   ${tokLine}  ${savedVS.padEnd(8)}  ${status}   ${idStr}`);
  }

  console.log();
  console.log(chalk.dim(`  Run ${chalk.cyan('badgr-auto receipt <id>')} for routing diagnosis.`));
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

  const tier           = TIER_LABELS[row.route_tier] || row.route_tier || '—';
  const preferredLabel = TIER_LABELS[row.preferred_tier] || row.preferred_tier;
  const routeDisplay   = row.route_fallback_used && preferredLabel && preferredLabel !== tier
    ? `${preferredLabel} → ${tier}`
    : tier;
  const tool        = toolLabel(row);
  const saved       = (row.original_tokens || 0) - (row.optimized_tokens || 0);
  const pct         = row.original_tokens > 0 ? Math.round((saved / row.original_tokens) * 100) : 0;
  const isError     = (row.status_code || 200) >= 400;
  const isSlow      = row.latency_target_ms && row.latency_ms > row.latency_target_ms;
  const chargeLabel = CHARGE_STATUS_LABELS[row.charge_status] || row.charge_status || '—';

  if (doExport) {
    const lines = [
      `# Badgr Auto Support Bundle — Request #${row.id}`,
      `Generated: ${new Date().toISOString()}`,
      '',
      '## Routing Decision',
      `Route:                 ${routeDisplay}`,
      `Route reason:          ${row.route_reason || '—'}`,
      `Fallback used:         ${row.route_fallback_used ? 'yes' : 'no'}`,
      `Tool:                  ${tool}`,
      `Model:                 ${row.model || '—'}`,
      '',
      '## Tokens',
      `Input tokens:          ${row.original_tokens || 0}`,
      `Optimized tokens:      ${row.optimized_tokens || 0}`,
      `Output tokens:         ${row.output_tokens_received || 0}`,
      `Cached tokens:         ${row.cached_tokens || 0}`,
      '',
      '## Cost',
      `Actual cost:           $${(row.actual_cost_usd || 0).toFixed(6)}`,
      `Est. saved vs Sonnet:       $${(row.estimated_savings_vs_sonnet || 0).toFixed(6)}`,
      '',
      '## Timing',
      `Latency:               ${row.latency_ms || 0}ms`,
      `Started at:            ${row.started_at || '—'}`,
      `Ended at:              ${row.ended_at || '—'}`,
      '',
      '## Outcome',
      `Status code:           ${row.status_code || '—'}`,
      `Stream completed:      ${row.stream_completed ? 'yes' : 'no'}`,
      `Client disconnected:   ${row.client_disconnected ? 'yes' : 'no'}`,
      `Timed out:             ${row.timed_out ? 'yes' : 'no'}`,
      `Charge status:         ${chargeLabel}`,
      '',
      '## Provider',
      `Provider request ID:   ${row.provider_request_id || '—'}`,
      `Actual route:          ${row.actual_route || '—'}`,
    ];
    console.log(lines.join('\n'));
    return;
  }

  console.log();
  console.log(chalk.bold(`  Request #${row.id}`) + chalk.dim(`  ${tool}  ${fmtTime(row.created_at)}`));
  console.log();

  // ── Routing decision ─────────────────────────────────────────────────────
  console.log(chalk.dim('  ── Routing decision ' + '─'.repeat(48)));
  if (row.route_reason) {
    console.log(col('  Why this route:', row.route_reason));
  }
  const notLocal   = whyNotLocal(row);
  const notPremium = whyNotPremium(row);
  if (notLocal)   console.log(col('  Why not local:', notLocal));
  if (notPremium) console.log(col('  Why not Claude:', notPremium));
  console.log(col('  Route:', routeDisplay));
  console.log(col('  Model:', row.model || '—'));
  if (row.route_fallback_used && preferredLabel && preferredLabel !== tier) {
    console.log(col('  Fallback:', chalk.yellow(`${preferredLabel} unavailable → used ${tier}`)));
  } else {
    console.log(col('  Fallback:', 'none'));
  }
  console.log();

  // ── Cost & savings ───────────────────────────────────────────────────────
  console.log(chalk.dim('  ── Cost & savings ' + '─'.repeat(50)));
  console.log(col('  Tokens:', `${fmtTokens(row.original_tokens)} → ${fmtTokens(row.optimized_tokens)}${pct > 0 ? `  (${pct}% removed)` : ''}`));
  console.log(col('  Actual cost:', chalk.green(`$${(row.actual_cost_usd || 0).toFixed(4)}`)));
  if ((row.estimated_savings_vs_sonnet || 0) > 0) {
    console.log(col('  Est. saved vs Sonnet:', chalk.green(`$${(row.estimated_savings_vs_sonnet).toFixed(4)}`)));
  }
  if (isError) {
    const hint = ERROR_HINTS[row.status_code] ? ` — ${ERROR_HINTS[row.status_code]}` : '';
    console.log(col('  Error:', chalk.red(`${row.status_code}${hint}`)));
  }
  if (row.charge_status) {
    const isChargeConcern = row.charge_status === 'potentially_charged' || row.charge_status === 'unknown';
    console.log(col('  Charge status:', isChargeConcern ? chalk.yellow(chargeLabel) : chargeLabel));
  }
  console.log();

  // ── Context health ───────────────────────────────────────────────────────
  if (row.context_used_percent != null) {
    console.log(chalk.dim('  ── Context health ' + '─'.repeat(49)));
    const pctStr = `${Number(row.context_used_percent).toFixed(1)}%`;
    if (row.context_used_percent >= 75) {
      console.log(col('  Context used:', chalk.red(`${pctStr} — compact now`)));
    } else if (row.context_used_percent >= 60) {
      console.log(col('  Context used:', chalk.yellow(`${pctStr} — compact soon`)));
    } else {
      console.log(col('  Context used:', pctStr));
    }
    console.log();
  }

  // ── Optimization receipt ───────────────────────────────────────────────────
  if ((row.tool_results_preserved || 0) > 0 || (row.files_read_count || 0) > 0 || row.optimization_rules_applied) {
    console.log(chalk.dim('  ── Optimization ' + '─'.repeat(51)));
    if ((row.tool_results_preserved || 0) > 0) {
      console.log(col('  Tool results kept:', String(row.tool_results_preserved)));
    }
    if ((row.files_read_count || 0) > 0) {
      console.log(col('  Files referenced:', String(row.files_read_count)));
    }
    if (row.optimization_rules_applied) {
      let rules;
      try { rules = JSON.parse(row.optimization_rules_applied); } catch { rules = null; }
      if (Array.isArray(rules) && rules.length > 0) {
        console.log(col('  Optimizations applied:', rules.join(', ')));
      }
    }
    console.log();
  }

  // ── Performance ──────────────────────────────────────────────────────────
  console.log(chalk.dim('  ── Performance ' + '─'.repeat(53)));
  const latencyDisplay = isSlow
    ? `${row.latency_ms}ms  ${chalk.yellow('⚠ slower than target')}`
    : `${row.latency_ms}ms`;
  console.log(col('  Latency:', latencyDisplay));
  if (row.provider_request_id) console.log(col('  Provider request ID:', row.provider_request_id));
  console.log();
}
