import { readSavingsStats, REQUEST_LOG_DB } from '../db.js';

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

  const avgPct   = typeof stats.avg_saved_pct === 'number' ? stats.avg_saved_pct.toFixed(1) : '0.0';
  const usd      = typeof stats.total_usd === 'number' ? stats.total_usd.toFixed(2) : '0.00';
  const latency  = typeof stats.avg_latency_ms === 'number' ? Math.round(stats.avg_latency_ms) : 0;
  const origTok  = (stats.total_original || 0).toLocaleString();
  const optTok   = (stats.total_optimized || 0).toLocaleString();
  const savedTok = (stats.total_saved || 0).toLocaleString();

  console.log();
  console.log(chalk.bold(`  Token savings — ${label}`));
  console.log();
  console.log(`  Requests:          ${chalk.cyan(stats.requests.toLocaleString())}`);
  console.log(`  Original tokens:   ${chalk.dim(origTok)}`);
  console.log(`  Optimized tokens:  ${chalk.green(optTok)}`);
  console.log(`  Tokens saved:      ${chalk.green(savedTok)}`);
  console.log(`  Average reduction: ${chalk.green(`${avgPct}%`)}`);
  console.log(`  Estimated saved:   ${chalk.green(`$${usd}`)}`);
  console.log();

  // Tier breakdown — only show if we have tier data
  const localPct   = stats.local_pct   ?? 0;
  const midPct     = stats.mid_pct     ?? 0;
  const asyncPct   = stats.async_pct   ?? 0;
  const premiumPct = stats.premium_pct ?? 0;

  if (localPct + midPct + asyncPct + premiumPct > 0) {
    if (localPct > 0)   console.log(`  Local requests:    ${localPct}%`);
    if (midPct > 0)     console.log(`  OSS cloud:         ${midPct}%`);
    if (asyncPct > 0)   console.log(`  Async GPU:         ${asyncPct}%`);
    if (premiumPct > 0) console.log(`  Premium:           ${premiumPct}%`);
    console.log();
  }

  console.log(`  Avg latency:       ${chalk.dim(`${latency}ms`)}`);
  console.log();
  console.log(chalk.dim(`  Local log: ${REQUEST_LOG_DB}`));
  console.log();
}
