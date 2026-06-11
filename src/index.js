#!/usr/bin/env node
import chalk from 'chalk';
import { readProxyPort } from './proxy-config.js';
import { loginCommand }   from './commands/login.js';
import { startCommand, setupCommand } from './commands/start.js';
import { stopCommand }    from './commands/stop.js';
import { statusCommand }  from './commands/status.js';
import { statsCommand }   from './commands/stats.js';
import { modelsCommand }  from './commands/models.js';
import { selectCommand }  from './commands/select.js';
import { restartCommand } from './commands/restart.js';
import { receiptsCommand, receiptCommand } from './commands/receipts.js';
import { dashboardCommand } from './commands/dashboard.js';
import { monitorCommand } from './commands/monitor.js';
import { evalCommand }   from './commands/eval.js';
import { newTaskCommand } from './commands/new-task.js';

const HELP = `
${chalk.bold('Badgr Token Proxy')} (${chalk.cyan('badgr-auto')}) — local OpenAI-compatible context optimizer

${chalk.bold('MVP FLOW')}
  Coding tool → localhost proxy → dedupe/compress/log → route tier → same-format response
  Supports both streaming (text/event-stream) and buffered JSON.

${chalk.bold('SETUP')}
  ${chalk.cyan('npm install -g badgr-auto')}           Install (once)
  ${chalk.cyan('badgr-auto start')}                   Guided setup (or status menu if running)
  ${chalk.cyan('badgr-auto setup')}                   Re-run guided setup wizard
  ${chalk.cyan('badgr-auto restart')}                 Restart proxy with current config
  ${chalk.cyan('badgr-auto login')}                   Connect AI Badgr (interactive)
  ${chalk.cyan('badgr-auto login --api-key <key>')}   Non-interactive login (CI/scripted)
  ${chalk.cyan('badgr-auto stop')}                    Stop the proxy
  ${chalk.cyan('badgr-auto status')}                  Show proxy status

${chalk.bold('OPENAI-COMPATIBLE ENDPOINTS')}
  ${chalk.cyan('POST /v1/chat/completions')}          Optimizes and forwards (streaming or buffered)
  ${chalk.cyan('GET  /v1/models')}                    Proxies upstream model list

${chalk.bold('CONFIGURE CODING TOOLS')}
  Base URL: ${chalk.cyan(`http://localhost:${readProxyPort()}/v1`)}
  API Key:  ${chalk.dim('your AI Badgr API key (after cloud setup)')}
  Model:    ${chalk.cyan('badgr-auto')} (or your normal model)

${chalk.bold('SAVINGS')}
  ${chalk.cyan('badgr-auto stats')}                   All-time token savings summary
  ${chalk.cyan('badgr-auto stats 1d')}                Last 24 hours
  ${chalk.cyan('badgr-auto stats 7d')}                Last 7 days
  ${chalk.cyan('badgr-auto receipts')}               Recent request list
  ${chalk.cyan('badgr-auto receipt <id>')}            Single request receipt
  ${chalk.cyan('badgr-auto monitor')}                 Live request monitor (interactive — Ctrl+C to stop)
  ${chalk.cyan('badgr-auto dashboard')}               Open savings dashboard

${chalk.bold('CONTEXT MANAGEMENT')}
  ${chalk.cyan('badgr-auto new-task')}                Start a new task (saves handoff note)
  ${chalk.cyan('badgr-auto new-task --template')}     Print blank handoff template

${chalk.bold('SHADOW EVAL')}
  ${chalk.cyan('badgr-auto start --eval-sample 0.05')}  Sample 5% of requests for eval
  ${chalk.cyan('badgr-auto eval list')}               List stored eval payloads
  ${chalk.cyan('badgr-auto eval <id>')}               Replay request and compare outputs

${chalk.bold('OPTIMIZATION RULES')}
  • Keep system prompts untouched
  • Keep tool call JSON/function schemas untouched
  • Keep the latest user message untouched
  • Remove duplicate identical message content, keeping the latest copy
  • Above 12,000 input tokens, summarize older text and keep latest 8 messages untouched
  • Route across edge, mid-tier, async, and premium tiers by complexity/latency/cost
  • Default most normal work to mid-tier; escalate only when needed
  • Log original tokens, optimized tokens, tokens saved, selected route, estimated savings, and latency

${chalk.bold('GOOD FIRST TOOLS')}
  Cline, Continue.dev, Aider, OpenClaw, OpenAI SDK scripts, LangChain apps, LiteLLM-compatible tools
`;

async function main() {
  const [,, cmd, ...rest] = process.argv;

  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
    return;
  }

  switch (cmd) {
    case 'login':   return loginCommand(chalk, rest);
    case 'start':   return startCommand(chalk, rest);
    case 'setup':   return setupCommand(chalk);
    case 'restart': return restartCommand(chalk);
    case 'stop':    return stopCommand(chalk);
    case 'status':  return statusCommand(chalk);
    case 'stats':   return statsCommand(chalk, rest);
    case 'receipts':  return receiptsCommand(chalk, rest);
    case 'receipt':   return receiptCommand(chalk, rest);
    case 'dashboard': return dashboardCommand(chalk);
    case 'monitor':   return monitorCommand(chalk);
    case 'eval':      return evalCommand(chalk, rest);
    case 'new-task':  return newTaskCommand(chalk, rest);
    // Legacy local-model helpers remain for users who installed early builds.
    case 'models': return modelsCommand(chalk);
    case 'select': return selectCommand(rest[0], chalk);
    default:
      console.error(chalk.red(`Unknown command: ${cmd}\n`));
      console.log(`Run ${chalk.cyan('badgr-auto --help')} for usage.`);
      process.exit(1);
  }
}

main().catch(err => {
  console.error(chalk.red('Fatal:'), err.message);
  process.exit(1);
});
