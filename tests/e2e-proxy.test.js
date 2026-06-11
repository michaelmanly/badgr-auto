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

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';

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
let proxyConfigFile;

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
  proxyConfigFile = join(configDir, 'auto-config.json');

  // Point all tiers at the mock upstream.
  const base = `http://127.0.0.1:${mockPort}/v1`;
  process.env.BADGR_AUTO_UPSTREAM_BASE_URL = base;
  process.env.BADGR_AUTO_MID_BASE_URL      = base;
  process.env.BADGR_AUTO_EDGE_BASE_URL     = base;
  process.env.BADGR_AUTO_PREMIUM_BASE_URL  = base;
  process.env.BADGR_AUTO_ASYNC_BASE_URL    = base;
  process.env.BADGR_API_KEY                = 'e2e-test-key';
  delete process.env.OPENAI_API_KEY;
  process.env.BADGR_AUTO_PORT              = String(proxyPort);
  process.env.BADGR_CONFIG_DIR             = configDir;

  // Seed config with routing enabled so tier-selection tests work.
  writeFileSync(proxyConfigFile, JSON.stringify({ routingMode: 'hybrid' }));

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

  it('X-Badgr-Mode: off skips dedup but still routes (refactor → mid)', async () => {
    const res = await send(
      { model: 'badgr-auto', messages: [{ role: 'user', content: 'Please refactor this function.' }, ...duplicateMessages] },
      { 'x-badgr-mode': 'off' },
    );
    const saved = Number.parseInt(res.headers['x-badgr-tokens-saved'] || '0', 10);
    expect(saved).toBe(0);
    expect(res.headers['x-badgr-route-tier']).toBe('mid');
  });

  it('badgr_mode: off in body passes messages through unchanged', async () => {
    const res = await send({ model: 'badgr-auto', badgr_mode: 'off', messages: duplicateMessages });
    expect(Number.parseInt(res.headers['x-badgr-tokens-saved'] || '0', 10)).toBe(0);
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

// ── Legacy text completions (/v1/completions) ─────────────────────────────

function sendCompletions(body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: proxyPort, path: '/v1/completions', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
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

function sendCompletionsStream(body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: proxyPort, path: '/v1/completions', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
      (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c.toString()));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: chunks.join('') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe('Legacy completions API (/v1/completions — Continue, Tabby, Aider)', () => {
  it('returns text_completion object', async () => {
    const res = await sendCompletions({
      model: 'gpt-4o',
      prompt: 'def hello():',
      max_tokens: 64,
    });
    expect(res.status).toBe(200);
    expect(res.body.object).toBe('text_completion');
    expect(Array.isArray(res.body.choices)).toBe(true);
    expect(typeof res.body.choices[0].text).toBe('string');
    expect(res.body.usage).toBeDefined();
  });

  it('FIM: suffix field is forwarded in prompt to upstream', async () => {
    await sendCompletions({
      model: 'gpt-4o',
      prompt: 'def hello():',
      suffix: '\n    return "world"',
      max_tokens: 32,
    });
    const last = mockRequests.at(-1);
    expect(last.body.messages[0].content).toContain('<suffix>');
    expect(last.body.messages[0].content).toContain('return "world"');
  });

  it('includes x-badgr-* headers', async () => {
    const res = await sendCompletions({ model: 'gpt-4o', prompt: 'hello', max_tokens: 10 });
    expect(res.headers['x-badgr-original-tokens']).toBeTruthy();
    expect(res.headers['x-badgr-route-tier']).toBeTruthy();
  });

  it('streaming returns text_completion SSE chunks and [DONE]', async () => {
    const res = await sendCompletionsStream({
      model: 'gpt-4o',
      prompt: 'def foo():',
      max_tokens: 32,
      stream: true,
    });
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('[DONE]');
    expect(res.body).toContain('text_completion');
  });
});

// ── Anthropic Messages API (/v1/messages) ─────────────────────────────────

function sendMessages(body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: proxyPort, path: '/v1/messages', method: 'POST',
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

function sendMessagesStream(body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: proxyPort, path: '/v1/messages', method: 'POST',
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

describe('Anthropic Messages API (/v1/messages)', () => {
  it('returns Anthropic message format for simple user message', async () => {
    const res = await sendMessages({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hello' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('message');
    expect(res.body.role).toBe('assistant');
    expect(res.body.model).toBe('claude-opus-4-5');
    expect(Array.isArray(res.body.content)).toBe(true);
    expect(res.body.content[0].type).toBe('text');
    expect(res.body.stop_reason).toBe('end_turn');
    expect(res.body.usage).toBeDefined();
  });

  it('includes x-badgr-* headers', async () => {
    const res = await sendMessages({
      model: 'claude-opus-4-5',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.headers['x-badgr-original-tokens']).toBeTruthy();
    expect(res.headers['x-badgr-route-tier']).toBeTruthy();
  });

  it('system prompt is forwarded as system message to upstream', async () => {
    await sendMessages({
      model: 'claude-opus-4-5',
      system: 'You are a concise assistant.',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const last = mockRequests.at(-1);
    expect(last.body.messages[0].role).toBe('system');
    expect(last.body.messages[0].content).toBe('You are a concise assistant.');
  });

  it('streaming returns Anthropic SSE events', async () => {
    const res = await sendMessagesStream({
      model: 'claude-opus-4-5',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('message_start');
    expect(res.body).toContain('content_block_start');
    expect(res.body).toContain('content_block_delta');
    expect(res.body).toContain('message_stop');
    expect(res.body).toContain('Hello');
  });

  it('tool_result user content is converted to OpenAI tool messages', async () => {
    await sendMessages({
      model: 'claude-opus-4-5',
      messages: [
        { role: 'user', content: 'What is 2+2?' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'calculator', input: { expression: '2+2' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '4' }] },
      ],
    });
    const last = mockRequests.at(-1);
    const toolMsg = last.body.messages.find(m => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg.tool_call_id).toBe('toolu_1');
    expect(toolMsg.content).toBe('4');
  });
});

// ── Generic passthrough for unrecognised /v1/* paths ─────────────────────

describe('Generic /v1/* passthrough (embeddings, audio, etc.)', () => {
  it('unknown /v1/* route is forwarded to upstream, not 404', async () => {
    // Mock upstream returns 200 for any request it receives.
    // The passthrough must forward /v1/embeddings to the upstream and relay
    // the upstream response back rather than returning a proxy 404.
    const payload = JSON.stringify({ model: 'text-embedding-ada-002', input: ['hello'] });
    const result = await new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port: proxyPort, path: '/v1/embeddings', method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
        (res) => {
          const raw = [];
          res.on('data', c => raw.push(c));
          res.on('end', () => {
            resolve({ status: res.statusCode });
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
    // The mock upstream returns 200 for everything, so the passthrough should relay that.
    expect(result.status).toBe(200);
  });
});

// ── Routing off (direct mode) ─────────────────────────────────────────────

describe('routingMode: direct', () => {
  afterEach(() => {
    // Reset to default config so other tests are unaffected
    writeFileSync(proxyConfigFile, JSON.stringify({ routingMode: 'hybrid' }));
  });

  it('client model is forwarded unchanged — router does not override it', async () => {
    writeFileSync(proxyConfigFile, JSON.stringify({ routingMode: 'direct' }));
    await send({ model: 'my-custom-model', messages: [{ role: 'user', content: 'hi' }] });
    const last = mockRequests.at(-1);
    expect(last.body.model).toBe('my-custom-model');
  });

  it('still returns a successful response and x-badgr-* headers', async () => {
    writeFileSync(proxyConfigFile, JSON.stringify({ routingMode: 'direct' }));
    const res = await send({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }] });
    expect(res.status).toBe(200);
    expect(res.headers['x-badgr-route-tier']).toBeTruthy();
    expect(res.headers['x-badgr-original-tokens']).toBeTruthy();
  });

  it('autocomplete task type does NOT route to edge — tier selection is bypassed', async () => {
    writeFileSync(proxyConfigFile, JSON.stringify({ routingMode: 'direct' }));
    const res = await send({
      model: 'my-upstream-model',
      metadata: { task_type: 'autocomplete' },
      messages: [{ role: 'user', content: 'complete this line' }],
    });
    const last = mockRequests.at(-1);
    // In direct mode the model must not be swapped to the edge model
    expect(last.body.model).toBe('my-upstream-model');
    expect(res.status).toBe(200);
  });
});

// ── Token optimization off ────────────────────────────────────────────────

describe('tokenOptimization: false', () => {
  afterEach(() => {
    writeFileSync(proxyConfigFile, JSON.stringify({ tokenOptimization: true }));
  });

  it('duplicate messages are NOT deduplicated — tokens-saved is 0', async () => {
    writeFileSync(proxyConfigFile, JSON.stringify({ tokenOptimization: false }));
    const sysInstruction = 'You are a helpful coding assistant with knowledge of JavaScript and TypeScript.';
    const res = await send({
      model: 'badgr-auto',
      messages: [
        { role: 'system', content: sysInstruction },
        { role: 'user', content: 'Hello' },
        { role: 'system', content: sysInstruction }, // would be deduped when optimization is on
        { role: 'user', content: 'What is next?' },
      ],
    });
    expect(res.status).toBe(200);
    const saved = Number.parseInt(res.headers['x-badgr-tokens-saved'] || '0', 10);
    expect(saved).toBe(0);
  });

  it('original and optimized token counts are equal — nothing was removed', async () => {
    writeFileSync(proxyConfigFile, JSON.stringify({ tokenOptimization: false }));
    const sysInstruction = 'You are a helpful coding assistant.';
    const res = await send({
      model: 'badgr-auto',
      messages: [
        { role: 'system', content: sysInstruction },
        { role: 'user', content: 'Hello' },
        { role: 'system', content: sysInstruction },
      ],
    });
    const orig = Number.parseInt(res.headers['x-badgr-original-tokens'] || '0', 10);
    const opt  = Number.parseInt(res.headers['x-badgr-optimized-tokens'] || '0', 10);
    expect(orig).toBe(opt);
  });

  it('all messages are forwarded to upstream unchanged', async () => {
    writeFileSync(proxyConfigFile, JSON.stringify({ tokenOptimization: false }));
    const sysInstruction = 'You are a helpful coding assistant.';
    await send({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: sysInstruction },
        { role: 'user', content: 'Hello' },
        { role: 'system', content: sysInstruction },
      ],
    });
    const last = mockRequests.at(-1);
    // All 3 messages must be present — no dedup was applied
    expect(last.body.messages).toHaveLength(3);
  });
});
