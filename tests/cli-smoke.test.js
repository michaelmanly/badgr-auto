/**
 * Smoke tests for badgr-auto CLI commands (non-interactive).
 * Spawns the real entrypoint and checks exit codes + key output.
 */

import { describe, it, expect } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'index.js');

async function runCli(args, { expectExit = 0, timeout = 20_000 } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      timeout,
      env: { ...process.env, FORCE_COLOR: '0' },
      maxBuffer: 5 * 1024 * 1024,
    });
    if (expectExit !== 0) {
      throw Object.assign(new Error(`expected exit ${expectExit}, got 0`), { stdout, stderr, code: 0 });
    }
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const code = typeof err.code === 'number' ? err.code : 1;
    if (code !== expectExit) throw err;
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code };
  }
}

const COMMANDS = [
  { args: ['--help'], expect: /badgr-auto/, label: '--help' },
  { args: ['-h'], expect: /Badgr Token Proxy/, label: '-h' },
  { args: ['status'], expect: /running|not running/, label: 'status' },
  { args: ['stats'], expect: /token|request|savings|No requests/i, label: 'stats' },
  { args: ['stats', '1d'], expect: /24 hours|token|request|No requests/i, label: 'stats 1d' },
  { args: ['stats', '7d'], expect: /7 days|token|request|No requests/i, label: 'stats 7d' },
  { args: ['receipts'], expect: /receipt|request|No requests/i, label: 'receipts' },
  { args: ['dashboard'], expect: /Dashboard|aibadgr\.com\/dashboard/, label: 'dashboard' },
  { args: ['models'], expect: /Detecting local|No local inference/, label: 'models' },
  { args: ['eval'], expect: /No eval payloads|STORED EVAL/i, label: 'eval (no args)' },
  { args: ['eval', 'list'], expect: /No eval payloads|STORED EVAL/i, label: 'eval list' },
  { args: ['new-task', '--template'], expect: /New Task Handoff/, label: 'new-task --template' },
];

describe('CLI smoke tests', () => {
  for (const { args, expect: pattern, label } of COMMANDS) {
    it(`${label} exits 0 and prints expected output`, async () => {
      const { stdout, stderr, code } = await runCli(args);
      expect(code).toBe(0);
      expect(stdout + stderr).toMatch(pattern);
    });
  }

  it('unknown command exits 1', async () => {
    const { stdout, stderr, code } = await runCli(['not-a-command'], { expectExit: 1 });
    expect(code).toBe(1);
    expect(stdout + stderr).toMatch(/Unknown command/);
  });

  it('stats with invalid period exits 1', async () => {
    const { stdout, stderr, code } = await runCli(['stats', '30d'], { expectExit: 1 });
    expect(code).toBe(1);
    expect(stdout + stderr).toMatch(/Unknown period/);
  });

  it('receipt without id exits 1', async () => {
    const { code } = await runCli(['receipt'], { expectExit: 1 });
    expect(code).toBe(1);
  });

  it('eval with invalid id exits 1', async () => {
    const { stdout, stderr, code } = await runCli(['eval', 'not-a-number'], { expectExit: 1 });
    expect(code).toBe(1);
    expect(stdout + stderr).toMatch(/Invalid request ID/);
  });

  it('eval with non-existent id exits 1', async () => {
    const { stdout, stderr, code } = await runCli(['eval', '99999'], { expectExit: 1 });
    expect(code).toBe(1);
    expect(stdout + stderr).toMatch(/No eval payload/);
  });

  it('login --api-key saves key non-interactively', async () => {
    const { stdout, stderr, code } = await runCli(['login', '--api-key', 'test_ci_key_smoke_12345']);
    expect(code).toBe(0);
    expect(stdout + stderr).toMatch(/Connected|Saved|saved/i);
  });

  it('login --ci reads key from BADGR_API_KEY env var', async () => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [CLI, 'login', '--ci'],
      {
        timeout: 10_000,
        env: { ...process.env, FORCE_COLOR: '0', BADGR_API_KEY: 'ci_env_key_smoke_99999' },
        maxBuffer: 5 * 1024 * 1024,
      }
    );
    expect(stdout + stderr).toMatch(/Connected|Saved|saved/i);
  });

  it('monitor starts and prints LIVE REQUESTS header then exits on kill', async () => {
    const output = await new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, 'monitor'], {
        env: { ...process.env, FORCE_COLOR: '0' },
      });
      let buf = '';
      const collect = d => { buf += d.toString(); };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.on('exit', () => resolve(buf));
      setTimeout(() => child.kill(), 3000);
    });
    expect(output).toMatch(/LIVE REQUESTS|Waiting for requests/i);
  }, 6000);
});
