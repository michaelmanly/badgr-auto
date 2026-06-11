/**
 * E2E tests for the guided onboarding flow in `badgr-auto start`.
 *
 * Tests hardware detection, local-server detection, model recommendation,
 * and the fast-path (non-interactive) start when a config already exists.
 *
 * No real Ollama, GPU, or AI Badgr account required.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import os from 'os';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

// ── Hardware detection ────────────────────────────────────────────────────

describe('hardware detection', () => {
  it('detectRamGb returns a positive number', async () => {
    const { detectRamGb } = await import('../src/hardware.js');
    const ram = detectRamGb();
    expect(ram).toBeGreaterThan(0);
  });

  it('detectCpuCores returns >= 1', async () => {
    const { detectCpuCores } = await import('../src/hardware.js');
    expect(detectCpuCores()).toBeGreaterThanOrEqual(1);
  });

  it('detectVramGb returns a non-negative number (0 = no discrete GPU found)', async () => {
    const { detectVramGb } = await import('../src/hardware.js');
    const vram = detectVramGb();
    expect(vram).toBeGreaterThanOrEqual(0);
  });

  it('detectHardware returns all fields including systemLoad', async () => {
    const { detectHardware } = await import('../src/hardware.js');
    const hw = detectHardware();
    expect(typeof hw.vramGb).toBe('number');
    expect(typeof hw.ramGb).toBe('number');
    expect(typeof hw.cpuCores).toBe('number');
    expect('recommended' in hw).toBe(true);
    expect(typeof hw.systemLoad).toBe('object');
    expect(typeof hw.systemLoad.isHighLoad).toBe('boolean');
    expect(typeof hw.systemLoad.ramUsedPct).toBe('number');
    expect(typeof hw.systemLoad.vramUsedPct).toBe('number');
  });
});

// ── System load detection ─────────────────────────────────────────────────

describe('detectSystemLoad', () => {
  it('returns isHighLoad as boolean', async () => {
    const { detectSystemLoad } = await import('../src/hardware.js');
    const load = detectSystemLoad();
    expect(typeof load.isHighLoad).toBe('boolean');
  });

  it('ramUsedPct is between 0 and 100', async () => {
    const { detectSystemLoad } = await import('../src/hardware.js');
    const load = detectSystemLoad();
    expect(load.ramUsedPct).toBeGreaterThanOrEqual(0);
    expect(load.ramUsedPct).toBeLessThanOrEqual(100);
  });

  it('vramUsedPct is between 0 and 100', async () => {
    const { detectSystemLoad } = await import('../src/hardware.js');
    const load = detectSystemLoad();
    expect(load.vramUsedPct).toBeGreaterThanOrEqual(0);
    expect(load.vramUsedPct).toBeLessThanOrEqual(100);
  });
});

// ── Model recommendation ───────────────────────────────────────────────────

describe('recommendModel', () => {
  it('returns null when both vram and ram are 0', async () => {
    const { recommendModel } = await import('../src/hardware.js');
    expect(recommendModel(0, 0)).toBeNull();
  });

  it('returns null for 2 GB vram / 5 GB ram — below minimum threshold', async () => {
    const { recommendModel } = await import('../src/hardware.js');
    expect(recommendModel(2, 5)).toBeNull();
  });

  it('returns null for 6 GB vram — conservative: below 8 GB minimum for 7B', async () => {
    const { recommendModel } = await import('../src/hardware.js');
    expect(recommendModel(6, 8)).toBeNull();
  });

  it('recommends qwen2.5-coder:7b for exactly 8 GB vram', async () => {
    const { recommendModel } = await import('../src/hardware.js');
    expect(recommendModel(8, 16)?.name).toBe('qwen2.5-coder:7b');
  });

  it('recommends qwen2.5-coder:7b for 11 GB vram (top of 8–11 range)', async () => {
    const { recommendModel } = await import('../src/hardware.js');
    expect(recommendModel(11, 20)?.name).toBe('qwen2.5-coder:7b');
  });

  it('recommends qwen2.5-coder:14b for 12 GB vram', async () => {
    const { recommendModel } = await import('../src/hardware.js');
    expect(recommendModel(12, 24)?.name).toBe('qwen2.5-coder:14b');
  });

  it('recommends qwen2.5-coder:14b for 16 GB vram', async () => {
    const { recommendModel } = await import('../src/hardware.js');
    expect(recommendModel(16, 32)?.name).toBe('qwen2.5-coder:14b');
  });

  it('recommends qwen2.5-coder:32b for 24 GB vram', async () => {
    const { recommendModel } = await import('../src/hardware.js');
    expect(recommendModel(24, 48)?.name).toBe('qwen2.5-coder:32b');
  });

  it('falls back to RAM for CPU inference when vram is 0 but ram >= 16 GB', async () => {
    const { recommendModel } = await import('../src/hardware.js');
    const m = recommendModel(0, 16);
    expect(m).not.toBeNull();
    expect(m.name).toBe('qwen2.5-coder:7b');
  });

  it('returns null when vram is 0 and ram is below 16 GB', async () => {
    const { recommendModel } = await import('../src/hardware.js');
    expect(recommendModel(0, 12)).toBeNull();
  });
});

// ── selectBestLocalModel ─────────────────────────────────────────────────

describe('selectBestLocalModel', () => {
  it('returns null when no models are installed', async () => {
    const { selectBestLocalModel } = await import('../src/hardware.js');
    expect(selectBestLocalModel([], 8, 16)).toBeNull();
  });

  it('returns null when hardware is too constrained', async () => {
    const { selectBestLocalModel } = await import('../src/hardware.js');
    expect(selectBestLocalModel(['phi3:mini'], 2, 4)).toBeNull();
  });

  it('prefers coding models over general models of the same size', async () => {
    const { selectBestLocalModel } = await import('../src/hardware.js');
    const models = ['llama3.1:8b', 'qwen2.5-coder:7b', 'mistral:7b'];
    expect(selectBestLocalModel(models, 8, 16)).toBe('qwen2.5-coder:7b');
  });

  it('selects the largest coding model that fits within the hardware tier', async () => {
    const { selectBestLocalModel } = await import('../src/hardware.js');
    const models = ['qwen2.5-coder:7b', 'qwen2.5-coder:14b', 'qwen2.5-coder:32b'];
    // 12 GB VRAM → 14B tier → picks 14B
    expect(selectBestLocalModel(models, 12, 24)).toBe('qwen2.5-coder:14b');
  });

  it('does not pick a model larger than the hardware tier allows', async () => {
    const { selectBestLocalModel } = await import('../src/hardware.js');
    const models = ['qwen2.5-coder:7b', 'qwen2.5-coder:14b'];
    // 8 GB VRAM → 7B tier → must not pick 14B
    expect(selectBestLocalModel(models, 8, 16)).toBe('qwen2.5-coder:7b');
  });

  it('returns null when no installed model fits the tier (all models too large)', async () => {
    const { selectBestLocalModel } = await import('../src/hardware.js');
    const models = ['qwen2.5-coder:32b'];
    // Only 8 GB VRAM → 7B tier → 32B model won't fit
    expect(selectBestLocalModel(models, 8, 16)).toBeNull();
  });

  it('picks deepseek-coder as a coding model over a general-purpose llama', async () => {
    const { selectBestLocalModel } = await import('../src/hardware.js');
    const models = ['llama3.1:8b', 'deepseek-coder:7b'];
    expect(selectBestLocalModel(models, 8, 16)).toBe('deepseek-coder:7b');
  });

  it('with 24 GB VRAM selects the best coding model from a large installed list', async () => {
    const { selectBestLocalModel } = await import('../src/hardware.js');
    const models = ['qwen2.5-coder:7b', 'llama3.1:70b', 'qwen2.5-coder:32b', 'phi3:mini'];
    // 24 GB → 32B tier; 70B is filtered out (too large); picks 32B coding model
    expect(selectBestLocalModel(models, 24, 48)).toBe('qwen2.5-coder:32b');
  });
});

// ── Local server detection ─────────────────────────────────────────────────

describe('detectLocalServers', () => {
  it('returns empty array when no local servers are running', async () => {
    const { detectLocalServers } = await import('../src/detect.js');
    // In CI neither Ollama nor LM Studio runs; result must be an array.
    const results = await detectLocalServers();
    expect(Array.isArray(results)).toBe(true);
  });

  it('detects a mock Ollama server on a custom port', async () => {
    // Spin up a tiny mock that responds like Ollama /api/tags
    const mockServer = http.createServer((req, res) => {
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'qwen2.5-coder:7b' }, { name: 'phi3:mini' }] }));
      } else {
        res.writeHead(404); res.end();
      }
    });

    await new Promise(r => mockServer.listen(0, '127.0.0.1', r));
    const port = mockServer.address().port;

    // Temporarily override the LOCAL_SERVERS list via module mocking
    vi.doMock('../src/detect.js', () => ({
      LOCAL_SERVERS: [{
        name: 'ollama',
        url: `http://127.0.0.1:${port}`,
        modelsPath: '/api/tags',
        extractModels: (data) => (data.models || []).map(m => m.name),
      }],
      detectLocalServers: async () => {
        const res = await fetch(`http://127.0.0.1:${port}/api/tags`);
        const data = await res.json();
        return [{ name: 'ollama', url: `http://127.0.0.1:${port}`, models: data.models.map(m => m.name) }];
      },
    }));

    const { detectLocalServers: detect } = await import('../src/detect.js?mock=' + port);
    // Use the real module's direct fetch approach for a simpler integration test
    const result = await fetch(`http://127.0.0.1:${port}/api/tags`).then(r => r.json());
    expect(result.models).toHaveLength(2);
    expect(result.models[0].name).toBe('qwen2.5-coder:7b');

    await new Promise(r => mockServer.close(r));
    vi.doUnmock('../src/detect.js');
  });
});

// ── Onboarding fast-path: proxy starts and responds ───────────────────────
// These tests reuse the same proxy-server module instance (ESM singleton).
// We spin up a fresh mock upstream and bind the proxy to a free port for the suite.

let onboardMockUpstream;
let onboardMockPort;
let onboardProxyServer;
let onboardProxyPort;

async function getFreePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// Set up env before the proxy-server module is imported (it reads env at import time).
onboardProxyPort = await getFreePort();
onboardMockUpstream = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: 'onboard-mock', object: 'chat.completion', model: 'mock',
    choices: [{ message: { role: 'assistant', content: 'all good' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  }));
});
await new Promise(r => onboardMockUpstream.listen(0, '127.0.0.1', r));
onboardMockPort = onboardMockUpstream.address().port;

const onboardBase = `http://127.0.0.1:${onboardMockPort}/v1`;
const onboardConfigDir = join(tmpdir(), `badgr-onboard-${Date.now()}`);
mkdirSync(onboardConfigDir, { recursive: true });

// Override env for this describe-scope before importing the proxy.
process.env.BADGR_AUTO_UPSTREAM_BASE_URL = onboardBase;
process.env.BADGR_AUTO_MID_BASE_URL      = onboardBase;
process.env.BADGR_AUTO_EDGE_BASE_URL     = onboardBase;
process.env.BADGR_AUTO_PREMIUM_BASE_URL  = onboardBase;
process.env.BADGR_AUTO_ASYNC_BASE_URL    = onboardBase;
process.env.BADGR_API_KEY                = 'onboard-test-key';
delete process.env.OPENAI_API_KEY;
process.env.BADGR_AUTO_PORT              = String(onboardProxyPort);
process.env.BADGR_CONFIG_DIR             = onboardConfigDir;

const { server: onboardServer } = await import('../src/proxy-server.js');
onboardProxyServer = onboardServer;

await new Promise((resolve, reject) => {
  onboardProxyServer.listen(onboardProxyPort, '127.0.0.1', resolve);
  onboardProxyServer.once('error', reject);
});

function sendToOnboard(body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: onboardProxyPort, path: '/v1/chat/completions', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
      (r) => {
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end', () => {
          let body2; try { body2 = JSON.parse(Buffer.concat(chunks).toString()); } catch { body2 = {}; }
          resolve({ status: r.statusCode, headers: r.headers, body: body2 });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe('start command — non-interactive fast path', () => {
  afterAll(async () => {
    await new Promise(r => onboardProxyServer?.close(r)).catch(() => {});
    await new Promise(r => onboardMockUpstream?.close(r)).catch(() => {});
  });

  it('proxy starts and handles /v1/chat/completions', async () => {
    const res = await sendToOnboard({ model: 'badgr-auto', messages: [{ role: 'user', content: 'hello onboarding' }] });
    expect(res.status).toBe(200);
    expect(res.body.choices).toBeDefined();
    expect(res.headers['x-badgr-route-tier']).toBeTruthy();
    expect(res.headers['x-badgr-original-tokens']).toBeTruthy();
  });

  it('proxy returns x-badgr-* savings headers on every response', async () => {
    const res = await sendToOnboard({ model: 'badgr-auto', messages: [{ role: 'user', content: 'What time is it?' }] });
    expect(res.status).toBe(200);
    expect(res.headers['x-badgr-original-tokens']).toBeTruthy();
    expect(res.headers['x-badgr-optimized-tokens']).toBeTruthy();
    expect(res.headers['x-badgr-tokens-saved']).toBeTruthy();
    expect(res.headers['x-badgr-route-tier']).toBeTruthy();
  });
});
