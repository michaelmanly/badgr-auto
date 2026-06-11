import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const TEMPLATE = `# New Task Handoff

## Goal
(describe what you want to accomplish)

## Current files
(list key files involved)

## Decisions made
(architecture choices, constraints, previous attempts)

## Open issues
(unresolved questions or blockers)

## Next step
(what the agent should do first)
`;

async function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

export async function newTaskCommand(chalk, args = []) {
  if (args.includes('--template')) {
    process.stdout.write(TEMPLATE);
    return;
  }

  console.log();
  console.log(chalk.bold('  New Task — fresh context handoff'));
  console.log(chalk.dim('  Answer a few questions to create a handoff note for the next session.'));
  console.log();

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const goal      = await ask(rl, chalk.cyan('  Goal: '));
  const files     = await ask(rl, chalk.cyan('  Key files (comma-separated, or leave blank): '));
  const decisions = await ask(rl, chalk.cyan('  Decisions made (or leave blank): '));
  const issues    = await ask(rl, chalk.cyan('  Open issues (or leave blank): '));
  const nextStep  = await ask(rl, chalk.cyan('  Next step: '));

  rl.close();

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename  = `task-handoff-${timestamp}.md`;
  const filepath  = join(process.cwd(), filename);

  const fileList = files.trim()
    ? files.split(',').map(f => `- ${f.trim()}`).join('\n')
    : '(not specified)';

  const content = [
    '# New Task Handoff',
    '',
    '## Goal',
    goal.trim() || '(not specified)',
    '',
    '## Current files',
    fileList,
    '',
    '## Decisions made',
    decisions.trim() || '(not specified)',
    '',
    '## Open issues',
    issues.trim() || '(not specified)',
    '',
    '## Next step',
    nextStep.trim() || '(not specified)',
    '',
  ].join('\n');

  writeFileSync(filepath, content, 'utf8');

  console.log();
  console.log(chalk.green(`  ✓ Saved to ${filename}`));
  console.log(chalk.dim('  Paste the contents into a new chat to carry context forward.'));
  console.log();
}
