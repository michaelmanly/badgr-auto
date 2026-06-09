import { readSavingsStats, REQUEST_LOG_DB } from '../db.js';
import { estimateHaikuCost, estimateSonnetCost } from '../pricing.js';

const PERIODS = [
  { key: '1d',  label: 'Last 24 hours' },
  { key: '7d',  label: 'Last 7 days' },
  { key: 'all', label: 'All time' },
];

export async function statsCommand(chalk, args = []) {
  const periodArg = args[0] || 'all';
  const validPeriods = PERIODS.map(p => p.key);

  if (!validPeriods.includes(periodArg)) {
    console.error(chalk.red(`\n  Unknown period: ${periodArg}`));
    console.log(`  Usage: badgr-auto stats [${validPeriods.join('|')}]\n`);
    process.exitCode = 1;
    return;
  }

  const label = PERIODS.find(p => p.key === periodArg)?.label || periodArg;

  let stats;
  try {
    stats = await readSavingsStats(periodArg);
  } catch (err) {
    console.error(chalk.red(`\n  Could not read local log: ${err.message}\n`));
    process.exitCode = 1;
    return;
  }

  if (stats.requests === 0) {
    console.log(chalk.dim(`\n  No requests logged for "${label}".`));
    console.log(chalk.dim('  Run badgr-auto start and send some requests through Cline, Continue, or Aider.\n'));
    return;
  }

  const avgPct      = typeof stats.avg_saved_pct === 'number' ? stats.avg_saved_pct.toFixed(1) : '0.0';
  const latency     = typeof stats.avg_latency_ms === 'number' ? Math.round(stats.avg_latency_ms) : 0;
  const origTok     = (stats.total_original || 0).toLocaleString();
  const savedTok    = (stats.total_saved || 0).toLocaleString();
  const totalOptimized = stats.total_optimized || 0;
  const actualCost  = stats.total_actual_cost ?? 0;

  // Reference costs: what Haiku / Sonnet would have charged for the same optimized tokens
  const haikuCost  = estimateHaikuCost(totalOptimized);
  const sonnetCost = estimateSonnetCost(totalOptimized);
  const savedVsHaiku  = Math.max(haikuCost - actualCost, 0);
  const savedVsSonnet = Math.max(sonnetCost - actualCost, 0);

  console.log();
  console.log(chalk.bold(`  Estimated savings — ${label}`));
  console.log();

  // ── 1. Token optimisation ─────────────────────────────────────────────────
  console.log(chalk.bold('  Token optimisation'));
  console.log();
  console.log(`  Requests:               ${chalk.cyan(stats.requests.toLocaleString())}`);
  console.log(`  Original tokens:        ${chalk.dim(origTok)}`);
  console.log(`  Optimized tokens:       ${chalk.green(totalOptimized.toLocaleString())}`);
  console.log(`  Tokens removed:         ${chalk.green(savedTok)}`);
  console.log(`  Average context reduction: ${chalk.green(`${avgPct}%`)}`);
  console.log();

  // ── 2. Routing savings ────────────────────────────────────────────────────
  console.log(chalk.bold('  Routing savings'));
  console.log();
  console.log(`  Actual cost:            ${chalk.green(`$${actualCost.toFixed(2)}`)}`);
  console.log();
  console.log(`  Cost using Claude Haiku:  $${haikuCost.toFixed(2)}`);
  console.log(`  Cost using Claude Sonnet: $${sonnetCost.toFixed(2)}`);
  console.log();
  console.log(`  Saved vs Claude Haiku:  ${chalk.green(`$${savedVsHaiku.toFixed(2)}`)}`);
  console.log(`  Saved vs Claude Sonnet: ${chalk.green(`$${savedVsSonnet.toFixed(2)}`)}`);
  console.log();

  // ── Routing breakdown ─────────────────────────────────────────────────────
  const localPct   = stats.local_pct   ?? 0;
  const midPct     = stats.mid_pct     ?? 0;
  const asyncPct   = stats.async_pct   ?? 0;
  const premiumPct = stats.premium_pct ?? 0;

  if (localPct + midPct + asyncPct + premiumPct > 0) {
    console.log('  Requests routed:');
    if (localPct > 0)   console.log(`    Local:            ${localPct}%`);
    if (midPct > 0)     console.log(`    OSS cloud:        ${midPct}%`);
    if (asyncPct > 0)   console.log(`    Async GPU:        ${asyncPct}%`);
    if (premiumPct > 0) console.log(`    Premium:          ${premiumPct}%`);
    console.log();
  }

  console.log(`  Avg latency:            ${chalk.dim(`${latency}ms`)}`);
  console.log();
  console.log(chalk.dim(`  Local log: ${REQUEST_LOG_DB}`));
  console.log();
}
