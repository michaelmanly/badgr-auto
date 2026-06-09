import { describe, it, expect } from 'vitest';
import { routeRequest, DEFAULT_ROUTING_OPTIONS } from '../src/router.js';

const config = {
  upstreamBaseUrl: 'https://mid.example/v1',
  midBaseUrl: 'https://mid.example/v1',
  edgeBaseUrl: 'http://127.0.0.1:11434/v1',
  asyncBaseUrl: 'https://async.example/v1',
  premiumBaseUrl: 'https://premium.example/v1',
  edgeModel: 'qwen2.5-coder:7b',
  midModel: 'deepseek-chat',
  asyncModel: 'async-worker',
  premiumModel: 'claude-sonnet-4-5',
};

describe('routeRequest', () => {
  it('routes IDE autocomplete to edge (Local) when edge is configured', () => {
    const route = routeRequest({ model: 'badgr-auto', metadata: { task_type: 'autocomplete' }, messages: [{ role: 'user', content: 'complete this line' }] }, config);

    expect(route.preferredTier).toBe('edge');
    expect(route.selectedTier).toBe('edge');
    expect(route.model).toBe('qwen2.5-coder:7b');
    expect(route.baseUrl).toBe(config.edgeBaseUrl);
  });

  it('routes refactors and normal queries to mid tier (DeepSeek) by default', () => {
    const route = routeRequest({ model: 'badgr-auto', messages: [{ role: 'user', content: 'Please refactor this function.' }] }, config);

    expect(route.selectedTier).toBe('mid');
    expect(route.model).toBe('deepseek-chat');
    expect(route.reason).toContain('normal');
  });

  it('routes background batch work to async/distributed GPUs', () => {
    const route = routeRequest({ model: 'badgr-auto', metadata: { task_type: 'indexing' }, messages: [{ role: 'user', content: 'Index these docs.' }] }, config);

    expect(route.selectedTier).toBe('async');
    expect(route.model).toBe('async-worker');
  });

  it('routes deep debugging to premium (Claude Sonnet) only when complexity requires it', () => {
    const route = routeRequest({ model: 'badgr-auto', metadata: { task_type: 'deep_debugging' }, messages: [{ role: 'user', content: 'Find the root cause.' }] }, config);

    expect(route.selectedTier).toBe('premium');
    expect(route.model).toBe('claude-sonnet-4-5');
  });

  it('falls back to mid-tier instead of defaulting to premium when edge is unavailable', () => {
    const route = routeRequest({ model: 'badgr-auto', metadata: { task_type: 'autocomplete' }, messages: [{ role: 'user', content: 'complete this' }] }, {
      ...config,
      edgeBaseUrl: '',
    });

    expect(route.preferredTier).toBe('edge');
    expect(route.selectedTier).toBe('mid');
    expect(route.fallbackUsed).toBe(true);
  });

  it('preserves an explicitly requested model instead of forcing one model for every request', () => {
    const route = routeRequest({ model: 'custom-model', messages: [{ role: 'user', content: 'normal question' }] }, config);

    expect(route.selectedTier).not.toBe('premium');
    expect(route.model).toBe('custom-model');
  });
});

describe('DEFAULT_ROUTING_OPTIONS', () => {
  it('edge threshold is 500 tokens — Local handles tiny tasks only', () => {
    expect(DEFAULT_ROUTING_OPTIONS.edgeMaxTokens).toBe(500);
  });

  it('premium threshold is 4096 tokens — Claude Sonnet only for large/complex prompts', () => {
    expect(DEFAULT_ROUTING_OPTIONS.premiumMinTokens).toBe(4096);
  });
});
