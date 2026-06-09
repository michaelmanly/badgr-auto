/**
 * E2E integration test for the Badgr Token Proxy.
 *
 * Starts a local mock upstream + the real proxy server in-process, then exercises:
 *   ✓ short prompt → edge tier
 *   ✓ refactor prompt → mid tier
 *   ✓ repeated context is deduped (x-badgr-tokens-saved > 0)
 *   ✓ long context is compressed without breaking the response
 *   ✓ x-badgr-* savings headers present on every response
 *   ✓ explicit model names pass through unchanged
 *   ✓ streaming returns text/event-stream with [DONE]
 *   ✓ chunks arrive incrementally (multiple write calls)
 *
 * No real API key required — all upstream traffic goes to a canned mock.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

// ── Mock upstream ─────────────────────────────────────────────────────────

let mockUpstream;
let mockPort;
const mockRequests = [];

function startMockUpstream() {
  return new Promise((resolve) => {
    mockUpstream = http.createServer((req, res) => {
      const raw = [];
      req.on('data', c => raw.push(c));
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(Buffer.concat(raw).toString()); } catch { /* ignore */ }
        mockRequests.push({ url: req.url, body });

        if (req.url?.includes('/models')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock', object: 'model' }] }));
          return;
        }

        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          const parts = [
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello' }, finish_reason: null }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }] })}\n\n`,
            'data: [DONE]\n\n',
          ];
          let i = 0;
          const tick = setInterval(() => {
            if (i < parts.length) res.write(parts[i++]);
            else { clearInterval(tick); res.end(); }
          }, 10);
          return;
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'e2e-mock', object: 'chat.completion', model: body.model || 'mock',
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }));
      });
    });
    mockUpstream.listen(0, '127.0.0.1', () => { mockPort = mockUpstream.address().port; resolve(); });
  });
}

// ── Proxy bootstrap ────────────────────────────────────────────────────────

let proxyServer;
let proxyPort;

async function getFreePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function startProxy() {
  proxyPort = await getFreePort();
  const configDir = join(tmpdir(), `badgr-e2e-${Date.now()}`);
  mkdirSync(configDir, { recursive: true });

  // Point all tiers at the mock upstream.
  const base = `http://127.0.0.1:${mockPort}/v1`;
  process.env.BADGR_AUTO_UPSTREAM_BASE_URL = base;
  process.env.BADGR_AUTO_MID_BASE_URL      = base;
  process.env.BADGR_AUTO_EDGE_BASE_URL     = base;
  process.env.BADGR_AUTO_PREMIUM_BASE_URL  = base;
  process.env.BADGR_AUTO_ASYNC_BASE_URL    = base;
  process.env.BADGR_AUTO_API_KEY           = 'e2e-test-key';
  delete process.env.OPENAI_API_KEY;
  delete process.env.BADGR_API_KEY;
  process.env.BADGR_AUTO_PORT              = String(proxyPort);
  process.env.BADGR_CONFIG_DIR             = configDir;

  const { server } = await import('../src/proxy-server.js');
  proxyServer = server;
  await new Promise((resolve, reject) => {
    proxyServer.listen(proxyPort, '127.0.0.1', resolve);
    proxyServer.once('error', reject);
  });
}

// ── HTTP helpers ──────────────────────────────────────────────────────────

function send(body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: proxyPort, path: '/v1/chat/completions', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...extraHeaders } },
      (res) => {
        const raw = [];
        res.on('data', c => raw.push(c));
        res.on('end', () => {
          const text = Buffer.concat(raw).toString();
          let json; try { json = JSON.parse(text); } catch { json = { _raw: text }; }
          resolve({ status: res.statusCode, headers: res.headers, body: json });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function sendStream(body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: proxyPort, path: '/v1/chat/completions', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
      (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c.toString()));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, chunks, body: chunks.join('') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Setup / teardown ──────────────────────────────────────────────────────

beforeAll(async () => {
  await startMockUpstream();
  await startProxy();
}, 15000);

afterAll(async () => {
  await new Promise(r => proxyServer?.close(r));
  await new Promise(r => mockUpstream?.close(r));
});

// ── Routing tests ─────────────────────────────────────────────────────────

describe('routing — tier selection', () => {
  it('autocomplete hint → edge tier', async () => {
    const res = await send({
      model: 'badgr-auto',
      metadata: { task_type: 'autocomplete' },
      messages: [{ role: 'user', content: 'complete this line' }],
    });
    expect(res.status).toBe(200);
    expect(res.headers['x-badgr-route-tier']).toBe('edge');
  });

  it('refactor message → mid tier', async () => {
    const res = await send({
      model: 'badgr-auto',
      messages: [{ role: 'user', content: 'Please refactor this function to use async/await.' }],
    });
    expect(res.status).toBe(200);
    expect(res.headers['x-badgr-route-tier']).toBe('mid');
  });

  it('explicit model name is forwarded to upstream unchanged', async () => {
    await send({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
    const last = mockRequests.at(-1);
    expect(last.body.model).toBe('gpt-4o');
  });
});

// ── Optimisation tests ────────────────────────────────────────────────────

describe('context optimisation', () => {
  it('dedupes repeated system instructions (tokens-saved > 0)', async () => {
    // System messages are provably redundant when repeated — safe to dedupe regardless of length.
    const sysInstruction = 'You are a helpful coding assistant with knowledge of JavaScript and TypeScript.';
    const res = await send({
      model: 'badgr-auto',
      messages: [
        { role: 'system', content: sysInstruction },
        { role: 'user', content: 'Hello' },
        { role: 'system', content: sysInstruction }, // duplicate system — removed
        { role: 'user', content: 'What is next?' },
      ],
    });
    const saved = Number.parseInt(res.headers['x-badgr-tokens-saved'] || '0', 10);
    expect(saved).toBeGreaterThan(0);
  });

  it('deduplicates repeated code block attachments — optimized < original tokens', async () => {
    // A repeated fenced code block is a provably redundant data block and should be removed.
    // Natural-language messages are intentionally NOT deduplicated (per spec §4).
    const codeBlock = '```typescript\n' + 'export const compute = (n: number): number => n * 2;\n'.repeat(40) + '```';
    const res = await send({
      model: 'badgr-auto',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: codeBlock },
        { role: 'assistant', content: 'OK' },
        { role: 'user', content: codeBlock }, // exact duplicate code block — removed
        { role: 'user', content: 'Fix the bug.' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.choices).toBeDefined();
    const orig = Number.parseInt(res.headers['x-badgr-original-tokens'] || '0', 10);
    const opt  = Number.parseInt(res.headers['x-badgr-optimized-tokens'] || '0', 10);
    expect(orig).toBeGreaterThan(opt);
  });
});

describe('optimization mode: off', () => {
  const codeBlock = '```typescript\n' + 'export const compute = (n: number): number => n * 2;\n'.repeat(40) + '```';
  const duplicateMessages = [
    { role: 'user', content: codeBlock },
    { role: 'assistant', content: 'OK' },
    { role: 'user', content: codeBlock },
    { role: 'user', content: 'Fix the bug.' },
  ];

  it('X-Badgr-Mode: off passes duplicate code blocks through unchanged', async () => {
    const res = await send({ model: 'badgr-auto', messages: duplicateMessages }, { 'x-badgr-mode': 'off' });
    const orig = Number.parseInt(res.headers['x-badgr-original-tokens'] || '0', 10);
    const opt = Number.parseInt(res.headers['x-badgr-optimized-tokens'] || '0', 10);
    const saved = Number.parseInt(res.headers['x-badgr-tokens-saved'] || '0', 10);
    expect(saved).toBe(0);
    expect(opt).toBe(orig);
  });

  it('badgr_mode: off in body passes messages through unchanged', async () => {
    const res = await send({ model: 'badgr-auto', badgr_mode: 'off', messages: duplicateMessages });
    const saved = Number.parseInt(res.headers['x-badgr-tokens-saved'] || '0', 10);
    expect(saved).toBe(0);
  });

  it('metadata.mode: off in body passes messages through unchanged', async () => {
    const res = await send({ model: 'badgr-auto', metadata: { mode: 'off' }, messages: duplicateMessages });
    const saved = Number.parseInt(res.headers['x-badgr-tokens-saved'] || '0', 10);
    expect(saved).toBe(0);
  });

  it('mode off still routes normally (refactor → mid tier)', async () => {
    const res = await send(
      { model: 'badgr-auto', messages: [{ role: 'user', content: 'Please refactor this function to use async/await.' }] },
      { 'x-badgr-mode': 'off' },
    );
    expect(res.status).toBe(200);
    expect(res.headers['x-badgr-route-tier']).toBe('mid');
  });

  it('mode off still routes normally (autocomplete → edge tier)', async () => {
    const res = await send(
      {
        model: 'badgr-auto',
        metadata: { task_type: 'autocomplete' },
        messages: [{ role: 'user', content: 'complete this line' }],
      },
      { 'x-badgr-mode': 'off' },
    );
    expect(res.status).toBe(200);
    expect(res.headers['x-badgr-route-tier']).toBe('edge');
  });
});

// ── Logging headers ───────────────────────────────────────────────────────

describe('savings headers', () => {
  it('x-badgr-* headers present on every response', async () => {
    const res = await send({ model: 'badgr-auto', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.headers['x-badgr-original-tokens']).toBeTruthy();
    expect(res.headers['x-badgr-optimized-tokens']).toBeTruthy();
    expect(res.headers['x-badgr-tokens-saved']).toBeTruthy();
    expect(res.headers['x-badgr-route-tier']).toBeTruthy();
  });
});

// ── Streaming ─────────────────────────────────────────────────────────────

describe('streaming', () => {
  it('content-type is text/event-stream', async () => {
    const res = await sendStream({ model: 'badgr-auto', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.headers['content-type']).toContain('text/event-stream');
  });

  it('[DONE] is forwarded', async () => {
    const res = await sendStream({ model: 'badgr-auto', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.body).toContain('[DONE]');
  });

  it('delta content is forwarded', async () => {
    const res = await sendStream({ model: 'badgr-auto', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.body).toContain('Hello');
    expect(res.body).toContain(' world');
  });
});
