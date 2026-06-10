import { readSavingsStats, REQUEST_LOG_DB } from '../db.js';

const PERIODS = [
  { key: '1d',  label: 'Last 24 hours' },
  { key: '7d',  label: 'Last 7 days' },
  { key: 'all', label: 'All time' },
];

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function col(label, value, width = 44) {
  return `  ${label.padEnd(width - value.length - 2)}${value}`;
}

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

  const avgPct   = typeof stats.avg_saved_pct === 'number' ? Math.round(stats.avg_saved_pct) : 0;
  const actualCost = stats.total_actual_cost ?? 0;
  const savedVsSonnet = stats.total_saved_vs_sonnet ?? 0;
  const savedVsHaiku  = stats.total_saved_vs_haiku  ?? 0;
  const removedTok = stats.total_context_tokens_removed ?? stats.total_saved ?? 0;
  const fallbacks  = stats.fallbacks_used ?? 0;

  console.log();
  console.log(chalk.bold(`  Badgr Auto — ${label}`));
  console.log();
  console.log(col('Estimated saved vs Sonnet:', chalk.green(`$${savedVsSonnet.toFixed(2)}`)));
  console.log(col('Estimated saved vs Haiku:', chalk.green(`$${savedVsHaiku.toFixed(2)}`)));
  console.log(col('Actual cloud spend:', chalk.cyan(`$${actualCost.toFixed(2)}`)));
  console.log();
  console.log(col('Tokens safely removed:', chalk.green(fmtTokens(removedTok))));
  console.log(col('Average reduction:', chalk.green(`${avgPct}%`)));
  console.log(col('Requests optimized:', chalk.cyan(stats.requests.toLocaleString())));
  console.log();

  // Routes
  const localPct   = stats.local_pct   ?? 0;
  const midPct     = stats.mid_pct     ?? 0;
  const asyncPct   = stats.async_pct   ?? 0;
  const premiumPct = stats.premium_pct ?? 0;
  if (localPct + midPct + asyncPct + premiumPct > 0) {
    console.log('  Routes:');
    if (localPct   > 0) console.log(col('  Local', `${localPct}%`));
    if (midPct     > 0) console.log(col('  OSS cloud', `${midPct}%`));
    if (asyncPct   > 0) console.log(col('  Async GPU', `${asyncPct}%`));
    if (premiumPct > 0) console.log(col('  Premium', `${premiumPct}%`));
    console.log();
  }

  console.log(col('Fallbacks used:', String(fallbacks)));
  console.log();
  console.log(chalk.dim(`  Local log: ${REQUEST_LOG_DB}`));
  console.log();
}
