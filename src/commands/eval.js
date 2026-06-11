import { readEvalPayload, readEvalResult, listEvalPayloads } from '../db.js';
import { runEval } from '../eval-runner.js';

export async function evalCommand(chalk, args = []) {
  const [subCmd, ...rest] = args;

  // ── List mode ─────────────────────────────────────────────────────────
  if (!subCmd || subCmd === 'list') {
    const rows = await listEvalPayloads({ limit: 20 });
    if (rows.length === 0) {
      console.log(chalk.dim('\n  No eval payloads stored.'));
      console.log(chalk.dim('  Start the proxy with --eval-sample 0.05 to collect 5% of requests.\n'));
      return;
    }
    console.log();
    console.log(chalk.bold('  STORED EVAL PAYLOADS'));
    console.log('  ' + '─'.repeat(44));
    for (const row of rows) {
      console.log(`  #${row.request_id}  ${(row.model || '—').padEnd(24)}  ${row.created_at}`);
    }
    console.log();
    console.log(`  Run ${chalk.cyan('badgr-auto eval <id>')} to replay and compare outputs.`);
    console.log();
    return;
  }

  // ── Replay mode ───────────────────────────────────────────────────────
  const requestId = Number.parseInt(subCmd, 10);
  if (!Number.isFinite(requestId) || requestId <= 0) {
    console.error(chalk.red(`\n  Invalid request ID: ${subCmd}\n`));
    process.exit(1);
  }

  const forceRerun = rest.includes('--force');

  // Use cached result unless --force
  if (!forceRerun) {
    const existing = await readEvalResult(requestId);
    if (existing) {
      console.log();
      _printResult(chalk, existing, requestId);
      console.log(chalk.dim('  (Cached result — use --force to re-run)\n'));
      return;
    }
  }

  const payload = await readEvalPayload(requestId);
  if (!payload) {
    console.error(chalk.red(`\n  No eval payload for request #${requestId}.`));
    console.error(chalk.dim('  Was --eval-sample set when it was processed?\n'));
    process.exit(1);
  }

  console.log();
  console.log(chalk.bold(`  Replaying request #${requestId}…`));
  console.log(`  Model:              ${payload.model || '—'}`);
  console.log(`  Original messages:  ${payload.original_messages.length}`);
  console.log(`  Optimized messages: ${payload.optimized_messages.length}`);
  if (payload.removed_blocks?.length > 0) {
    console.log(`  Removed blocks:     ${payload.removed_blocks.length}`);
  }
  console.log();
  process.stdout.write('  Calling model with original + optimized…');

  const result = await runEval(requestId);

  process.stdout.write('\r' + ' '.repeat(50) + '\r');

  if (result.error) {
    console.error(chalk.red(`  Error: ${result.error}\n`));
    process.exit(1);
  }

  _printResult(chalk, result, requestId);
}

function _coerce(result, camel, snake) {
  const v = result[camel] ?? result[snake];
  return v;
}

function _printResult(chalk, result, requestId) {
  const safe = _coerce(result, 'safe', 'safe');
  const toolCallsMatch          = _coerce(result, 'toolCallsMatch',          'tool_calls_match');
  const finishReasonMatch       = _coerce(result, 'finishReasonMatch',       'finish_reason_match');
  const missingContextComplaint = _coerce(result, 'missingContextComplaint', 'missing_context_complaint');
  const outputLengthDelta       = _coerce(result, 'outputLengthDelta',       'output_length_delta') ?? 0;
  const latencyOriginalMs       = _coerce(result, 'latencyOriginalMs',       'latency_original_ms');
  const latencyOptimizedMs      = _coerce(result, 'latencyOptimizedMs',      'latency_optimized_ms');
  const tokenUsageOriginal      = _coerce(result, 'tokenUsageOriginal',      'token_usage_original') ?? {};
  const tokenUsageOptimized     = _coerce(result, 'tokenUsageOptimized',     'token_usage_optimized') ?? {};

  const safeLabel = safe
    ? chalk.green('  ✓ SAFE — optimized output matches original')
    : chalk.red('  ✗ UNSAFE — output degradation detected');

  console.log(safeLabel);
  console.log();
  console.log('  Comparison:');

  const match = v => v ? chalk.green('✓ match')   : chalk.red('✗ mismatch');
  const flag  = v => v ? chalk.red('✗ yes')       : chalk.green('✓ no');

  console.log(`    Tool calls:                ${match(toolCallsMatch)}`);
  console.log(`    Finish reason:             ${match(finishReasonMatch)}`);
  console.log(`    Missing context complaint: ${flag(missingContextComplaint)}`);
  console.log(`    Output length delta:       ${outputLengthDelta > 0 ? '+' : ''}${outputLengthDelta} chars`);
  console.log();

  if (latencyOriginalMs != null || latencyOptimizedMs != null) {
    console.log('  Latency:');
    console.log(`    Original:   ${latencyOriginalMs ?? '—'}ms`);
    console.log(`    Optimized:  ${latencyOptimizedMs ?? '—'}ms`);
    console.log();
  }

  if (tokenUsageOriginal.prompt_tokens || tokenUsageOptimized.prompt_tokens) {
    console.log('  Token usage (upstream confirmed):');
    console.log(`    Original input:   ${tokenUsageOriginal.prompt_tokens ?? '—'}`);
    console.log(`    Optimized input:  ${tokenUsageOptimized.prompt_tokens ?? '—'}`);
    console.log(`    Original output:  ${tokenUsageOriginal.completion_tokens ?? '—'}`);
    console.log(`    Optimized output: ${tokenUsageOptimized.completion_tokens ?? '—'}`);
    console.log();
  }

  if (!safe) {
    console.log(chalk.yellow('  Recommendation:'));
    if (missingContextComplaint) {
      console.log(chalk.yellow('    Optimized output complained about missing context.'));
      console.log(chalk.yellow('    The removed blocks likely contained required information.'));
    }
    if (!toolCallsMatch) {
      console.log(chalk.yellow('    Tool call mismatch — removed context may have changed the decision.'));
    }
    if (!missingContextComplaint && !toolCallsMatch) {
      console.log(chalk.yellow('    Check removed_blocks for this request ID to identify the unsafe rule.'));
    }
    console.log();
  }
}
