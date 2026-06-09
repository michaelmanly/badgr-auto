import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { classifyRequest, estimatePromptTokens } from '../src/classify.js';
import { detectLocalServers, LOCAL_SERVERS } from '../src/detect.js';
import { isProxyRunning } from '../src/proxy-config.js';

// ---------------------------------------------------------------------------
// estimatePromptTokens
// ---------------------------------------------------------------------------

describe('estimatePromptTokens', () => {
  it('returns 0 for empty messages', () => {
    expect(estimatePromptTokens([])).toBe(0);
  });

  it('estimates tokens as length / 4 (ceiling)', () => {
    const messages = [{ role: 'user', content: 'hello' }]; // 5 chars → 2
    expect(estimatePromptTokens(messages)).toBe(2);
  });

  it('sums tokens across multiple messages', () => {
    const messages = [
      { role: 'system', content: 'You are a helpful assistant.' }, // 28
      { role: 'user',   content: 'What is 2+2?' },                 // 12
    ];
    expect(estimatePromptTokens(messages)).toBe(10);
  });

  it('handles non-array input gracefully', () => {
    expect(estimatePromptTokens(null)).toBe(0);
    expect(estimatePromptTokens(undefined)).toBe(0);
  });

  it('handles array content parts', () => {
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }];
    expect(estimatePromptTokens(messages)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// classifyRequest
// ---------------------------------------------------------------------------

describe('classifyRequest', () => {
  it('classifies a short message as simple', () => {
    const req = { messages: [{ role: 'user', content: 'Hi!' }] };
    expect(classifyRequest(req)).toBe('simple');
  });

  it('classifies a long message (>4096 tokens) as hard', () => {
    const longText = 'a'.repeat(4096 * 4 + 1);
    const req = { messages: [{ role: 'user', content: longText }] };
    expect(classifyRequest(req)).toBe('hard');
  });

  it('classifies a medium message (512–4096 tokens) as normal', () => {
    const medText = 'a'.repeat(2400);
    const req = { messages: [{ role: 'user', content: medText }] };
    expect(classifyRequest(req)).toBe('normal');
  });

  it('classifies refactor/debug/implement as normal (OSS, not Claude)', () => {
    for (const kw of ['refactor', 'debug', 'implement']) {
      const req = { messages: [{ role: 'user', content: `Please ${kw} this function.` }] };
      expect(classifyRequest(req), `expected '${kw}' → normal`).toBe('normal');
    }
  });

  it('classifies as hard when a hard keyword is present', () => {
    const req = { messages: [{ role: 'user', content: 'Describe the security posture of this codebase.' }] };
    expect(classifyRequest(req)).toBe('hard');
  });

  it('classifies as hard for architecture keyword', () => {
    const req = { messages: [{ role: 'user', content: 'Describe the architecture of this system.' }] };
    expect(classifyRequest(req)).toBe('hard');
  });

  it('quality mode always returns hard', () => {
    const req = { messages: [{ role: 'user', content: 'Hi!' }] };
    expect(classifyRequest(req, { mode: 'quality' })).toBe('hard');
  });

  it('cheap mode caps hard at normal for hard keywords', () => {
    const req = { messages: [{ role: 'user', content: 'Please analyze the architecture.' }] };
    expect(classifyRequest(req, { mode: 'cheap' })).toBe('normal');
  });

  it('cheap mode caps hard at normal for long prompts', () => {
    const longText = 'a'.repeat(4096 * 4 + 1);
    const req = { messages: [{ role: 'user', content: longText }] };
    expect(classifyRequest(req, { mode: 'cheap' })).toBe('normal');
  });

  it('cheap mode still allows simple classification', () => {
    const req = { messages: [{ role: 'user', content: 'Hello' }] };
    expect(classifyRequest(req, { mode: 'cheap' })).toBe('simple');
  });

  it('balanced mode (default) follows normal rules', () => {
    const req = { messages: [{ role: 'user', content: 'Hello' }] };
    expect(classifyRequest(req, { mode: 'balanced' })).toBe('simple');
  });

  it('handles missing messages gracefully', () => {
    expect(classifyRequest({})).toBe('simple');
    expect(classifyRequest({ messages: [] })).toBe('simple');
  });

  it('uses 500-token threshold — message at 501 tokens routes to normal not simple', () => {
    const text = 'a'.repeat(501 * 4);
    const req = { messages: [{ role: 'user', content: text }] };
    expect(classifyRequest(req)).toBe('normal');
  });

  it('message at exactly 500 tokens routes to simple (Local)', () => {
    const text = 'a'.repeat(500 * 4);
    const req = { messages: [{ role: 'user', content: text }] };
    expect(classifyRequest(req)).toBe('simple');
  });
});

// ---------------------------------------------------------------------------
// detectLocalServers
// ---------------------------------------------------------------------------

describe('detectLocalServers', () => {
  beforeEach(() => { vi.stubGlobal('fetch', undefined); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns detected servers with models when fetch succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.includes('11434')) {
        return { ok: true, json: async () => ({ models: [{ name: 'llama3:8b' }] }) };
      }
      throw new Error('connection refused');
    }));
    const servers = await detectLocalServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('ollama');
    expect(servers[0].models).toEqual(['llama3:8b']);
  });

  it('returns empty array when no servers are available', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection refused'); }));
    const servers = await detectLocalServers();
    expect(servers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// isProxyRunning
// ---------------------------------------------------------------------------

describe('isProxyRunning', () => {
  it('returns a boolean and does not throw', () => {
    expect(typeof isProxyRunning()).toBe('boolean');
  });
});
