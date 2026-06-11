/**
 * Tests for receipts and receipt commands, db query functions, and dashboard.
 *
 * Uses an in-memory SQLite DB (via tmpdir) to verify:
 *   - readRecentRequests returns rows newest-first with correct fields
 *   - readRequestById returns the correct row or null
 *   - readSavingsStats includes fallbacks_used count
 *   - receiptsCommand prints a table with the correct structure
 *   - receiptCommand prints full details for a known ID
 *   - receiptCommand errors cleanly on bad/missing IDs
 *   - dashboardCommand prints the dashboard URL
 *   - --failed / --fallback filters work end-to-end
 *   - slow-request warning and error status display
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

// ── Shared test environment ───────────────────────────────────────────────

const configDir = join(tmpdir(), `badgr-receipts-test-${Date.now()}`);
mkdirSync(configDir, { recursive: true });
process.env.BADGR_CONFIG_DIR = configDir;

// ── Import db functions after env is set ─────────────────────────────────

let saveRequestLog, readRecentRequests, readRequestById, readSavingsStats;

beforeAll(async () => {
  ({ saveRequestLog, readRecentRequests, readRequestById, readSavingsStats } =
    await import('../src/db.js'));

  // Row 1 — deepseek/cline (oldest)
  await saveRequestLog({
    model: 'deepseek-chat', originalTokens: 1000, optimizedTokens: 800,
    tokensSaved: 200, savedPercent: 20, estimatedSavingsUsd: 0.001,
    actualCostUsd: 0.0005, cachedTokens: 0, contextTokensRemoved: 200,
    estimatedSavingsVsHaiku: 0.002, estimatedSavingsVsSonnet: 0.008,
    estimatedCacheEligibleTokens: 50, clientProfile: 'coding',
    latencyMs: 400, statusCode: 200, routeTier: 'mid', preferredTier: 'mid',
    routeReason: 'normal coding task', routeFallbackUsed: false,
    latencyTargetMs: 2000, didDedupe: true, didCompress: false, streaming: false,
    client: 'cline', actualRoute: 'OSS cloud — deepseek-chat',
  });

  // Row 2 — qwen/continue
  await saveRequestLog({
    model: 'qwen2.5-coder:7b', originalTokens: 500, optimizedTokens: 450,
    tokensSaved: 50, savedPercent: 10, estimatedSavingsUsd: 0,
    actualCostUsd: 0, cachedTokens: 0, contextTokensRemoved: 50,
    estimatedSavingsVsHaiku: 0.001, estimatedSavingsVsSonnet: 0.003,
    estimatedCacheEligibleTokens: 0, clientProfile: 'coding',
    latencyMs: 180, statusCode: 200, routeTier: 'edge', preferredTier: 'edge',
    routeReason: 'small task, local model', routeFallbackUsed: false,
    latencyTargetMs: 250, didDedupe: false, didCompress: false, streaming: false,
    client: 'continue', actualRoute: 'Local — qwen2.5-coder:7b',
  });

  // Row 3 — gpt-4o/aider: 429 error + slow (latency 5100ms, target 500ms)
  await saveRequestLog({
    model: 'gpt-4o', originalTokens: 2000, optimizedTokens: 1800,
    tokensSaved: 200, savedPercent: 10, estimatedSavingsUsd: 0,
    actualCostUsd: 0, cachedTokens: 0, contextTokensRemoved: 200,
    estimatedSavingsVsHaiku: 0, estimatedSavingsVsSonnet: 0,
    estimatedCacheEligibleTokens: 0, clientProfile: 'coding',
    latencyMs: 5100, statusCode: 429, routeTier: 'mid', preferredTier: 'mid',
    routeReason: 'rate limited', routeFallbackUsed: false,
    latencyTargetMs: 500, didDedupe: false, didCompress: false, streaming: false,
    client: 'aider', actualRoute: 'OSS cloud — gpt-4o',
  });

  // Row 4 — claude/openclaw: fallback mid→premium (newest)
  await saveRequestLog({
    model: 'claude-sonnet-4-5', originalTokens: 8000, optimizedTokens: 5500,
    tokensSaved: 2500, savedPercent: 31, estimatedSavingsUsd: 0.012,
    actualCostUsd: 0.021, cachedTokens: 0, contextTokensRemoved: 2500,
    estimatedSavingsVsHaiku: 0.015, estimatedSavingsVsSonnet: 0.05,
    estimatedCacheEligibleTokens: 200, clientProfile: 'agent',
    latencyMs: 1800, statusCode: 200, routeTier: 'premium', preferredTier: 'mid',
    routeReason: 'complex task', routeFallbackUsed: true,   // ← fallback
    latencyTargetMs: 6000, didDedupe: true, didCompress: true, streaming: true,
    client: 'openclaw', actualRoute: 'Premium — claude-sonnet-4-5',
    streamCompleted: true, providerUsageReported: true,
    chargeStatus: 'confirmed_usage_reported', outputTokensReceived: 420,
  });

  // Row 5 — disconnected mid-stream: potentially_charged
  await saveRequestLog({
    model: 'claude-haiku-4-5', originalTokens: 3000, optimizedTokens: 2800,
    tokensSaved: 200, savedPercent: 7, estimatedSavingsUsd: 0,
    actualCostUsd: 0.003, cachedTokens: 0, contextTokensRemoved: 200,
    estimatedSavingsVsHaiku: 0, estimatedSavingsVsSonnet: 0.01,
    estimatedCacheEligibleTokens: 0, clientProfile: 'coding',
    latencyMs: 900, statusCode: 200, routeTier: 'premium', preferredTier: 'premium',
    routeReason: 'complex task', routeFallbackUsed: false,
    latencyTargetMs: 5000, didDedupe: false, didCompress: false, streaming: true,
    client: 'cursor', actualRoute: 'Premium — claude-haiku-4-5',
    streamCompleted: false, clientDisconnected: true, providerUsageReported: false,
    chargeStatus: 'potentially_charged', outputTokensReceived: 0,
    providerRequestId: 'req_abc123xyz', startedAt: '2026-06-10T12:00:00.000Z',
    endedAt: '2026-06-10T12:00:00.900Z',
  });
});

// ── readRecentRequests ────────────────────────────────────────────────────

describe('readRecentRequests', () => {
  it('returns rows newest-first', async () => {
    const rows = await readRecentRequests({ limit: 10 });
    expect(rows.length).toBe(5);
    expect(rows[0].id).toBeGreaterThan(rows[1].id);
    expect(rows[1].id).toBeGreaterThan(rows[2].id);
    expect(rows[2].id).toBeGreaterThan(rows[3].id);
  });

  it('respects the limit parameter', async () => {
    const rows = await readRecentRequests({ limit: 2 });
    expect(rows.length).toBe(2);
  });

  it('row contains all expected fields', async () => {
    const rows = await readRecentRequests({ limit: 10 });
    const row = rows.find(r => r.client === 'openclaw');
    expect(typeof row.id).toBe('number');
    expect(row.model).toBe('claude-sonnet-4-5');
    expect(row.client).toBe('openclaw');
    expect(row.actual_route).toBe('Premium — claude-sonnet-4-5');
    expect(row.route_tier).toBe('premium');
    expect(row.route_fallback_used).toBeTruthy();
  });

  it('returns an empty array when no rows match', async () => {
    // Use a future-date cutoff that no rows satisfy.
    const rows = await readRecentRequests({ limit: 10, period: '0d' });
    expect(rows.length).toBe(0);
  });
});

// ── readRecentRequests filters ────────────────────────────────────────────

describe('readRecentRequests filters', () => {
  it('failed:true returns only error-status rows', async () => {
    const rows = await readRecentRequests({ limit: 10, failed: true });
    expect(rows.length).toBe(1);
    expect(rows[0].status_code).toBeGreaterThanOrEqual(400);
    expect(rows[0].client).toBe('aider');
  });

  it('fallback:true returns only fallback rows', async () => {
    const rows = await readRecentRequests({ limit: 10, fallback: true });
    expect(rows.length).toBe(1);
    expect(rows[0].route_fallback_used).toBeTruthy();
    expect(rows[0].client).toBe('openclaw');
  });

  it('failed and fallback filters can be combined', async () => {
    // No row is both 429 and fallback in the seed data.
    const rows = await readRecentRequests({ limit: 10, failed: true, fallback: true });
    expect(rows.length).toBe(0);
  });
});

// ── readRequestById ───────────────────────────────────────────────────────

describe('readRequestById', () => {
  it('returns the correct row for a known id', async () => {
    const all = await readRecentRequests({ limit: 10 });
    const target = all[all.length - 1]; // oldest = deepseek-chat
    const row = await readRequestById(target.id);
    expect(row).not.toBeNull();
    expect(row.id).toBe(target.id);
    expect(row.model).toBe('deepseek-chat');
    expect(row.client).toBe('cline');
  });

  it('returns null for a non-existent id', async () => {
    const row = await readRequestById(999999);
    expect(row).toBeNull();
  });
});

// ── readSavingsStats (fallbacks_used) ────────────────────────────────────

describe('readSavingsStats fallbacks_used', () => {
  it('counts only rows with route_fallback_used=1', async () => {
    const stats = await readSavingsStats('all');
    expect(stats.requests).toBe(5);
    expect(stats.fallbacks_used).toBe(1); // only the premium/openclaw row has fallback=true
  });

  it('counts error_count (status_code >= 400) correctly', async () => {
    const stats = await readSavingsStats('all');
    // Row 3 (aider, gpt-4o) has status_code 429 — only error row
    expect(stats.error_count).toBe(1);
  });
});

// ── statsCommand error_count display ─────────────────────────────────────

describe('statsCommand error_count display', () => {
  it('shows Errors line when error_count > 0', async () => {
    const { statsCommand } = await import('../src/commands/stats.js');
    const lines = [];
    const mockChalk = new Proxy({}, {
      get: (_, p) => {
        if (p === 'bold' || p === 'dim' || p === 'green' || p === 'cyan' || p === 'yellow' || p === 'red' || p === 'blue') {
          return (s) => s;
        }
        return undefined;
      },
    });
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a) => lines.push(a.join(' '));
    console.error = (...a) => lines.push(a.join(' '));
    await statsCommand(mockChalk, ['all']);
    console.log = origLog;
    console.error = origErr;

    const body = lines.join('\n');
    expect(body).toMatch(/Errors/i);
    expect(body).toMatch(/1/); // one error row in the dataset
  });
});

// ── receiptsCommand output ────────────────────────────────────────────────

describe('receiptsCommand', () => {
  it('prints a table header and one row per request', async () => {
    const { receiptsCommand } = await import('../src/commands/receipts.js');
    const lines = [];
    const mockChalk = new Proxy({}, {
      get: (_, p) => typeof p === 'string' ? (s = '') => s : undefined,
    });
    const origLog = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    await receiptsCommand(mockChalk, []);
    console.log = origLog;

    const body = lines.join('\n');
    const lower = body.toLowerCase();
    expect(lower).toContain('recent requests');
    expect(lower).toContain('time');
    // All 4 tools should appear
    expect(lower).toContain('cline');
    expect(lower).toContain('continue');
    expect(lower).toContain('aider');
    expect(lower).toContain('openclaw');
  });
});

// ── receiptsCommand --failed / --fallback ─────────────────────────────────

describe('receiptsCommand filters', () => {
  it('--failed shows only error requests with label', async () => {
    const { receiptsCommand } = await import('../src/commands/receipts.js');
    const lines = [];
    const mockChalk = new Proxy({}, { get: (_, p) => typeof p === 'string' ? (s = '') => s : undefined });
    const origLog = console.log; console.log = (...a) => lines.push(a.join(' '));
    await receiptsCommand(mockChalk, ['--failed']);
    console.log = origLog;
    const lower = lines.join('\n').toLowerCase();
    expect(lower).toContain('errors only');
    expect(lower).toContain('aider');
    expect(lower).not.toContain('cline');
  });

  it('--fallback shows only fallback requests with label', async () => {
    const { receiptsCommand } = await import('../src/commands/receipts.js');
    const lines = [];
    const mockChalk = new Proxy({}, { get: (_, p) => typeof p === 'string' ? (s = '') => s : undefined });
    const origLog = console.log; console.log = (...a) => lines.push(a.join(' '));
    await receiptsCommand(mockChalk, ['--fallback']);
    console.log = origLog;
    const lower = lines.join('\n').toLowerCase();
    expect(lower).toContain('fallbacks only');
    expect(lower).toContain('openclaw');
    expect(lower).not.toContain('cline');
  });
});

// ── receiptCommand output ─────────────────────────────────────────────────

describe('receiptCommand', () => {
  it('prints full details for a known request ID', async () => {
    const { receiptCommand } = await import('../src/commands/receipts.js');
    const all = await readRecentRequests({ limit: 10 });
    const target = all[all.length - 1]; // deepseek-chat row

    const lines = [];
    const mockChalk = new Proxy({}, {
      get: (_, p) => typeof p === 'string' ? (s = '') => s : undefined,
    });
    const origLog = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    await receiptCommand(mockChalk, [String(target.id)]);
    console.log = origLog;

    const body = lines.join('\n');
    expect(body).toContain(`Request #${target.id}`);
    expect(body.toLowerCase()).toContain('cline');
    expect(body.toLowerCase()).toContain('oss cloud');
    expect(body).toContain('deepseek-chat');
    expect(body.toLowerCase()).toContain('normal coding task');
  });

  it('shows slow request warning when latency exceeds target', async () => {
    const { receiptCommand } = await import('../src/commands/receipts.js');
    const all = await readRecentRequests({ limit: 10 });
    const slowRow = all.find(r => r.status_code === 429); // 5100ms vs 500ms target

    const lines = [];
    const mockChalk = new Proxy({}, { get: (_, p) => typeof p === 'string' ? (s = '') => s : undefined });
    const origLog = console.log; console.log = (...a) => lines.push(a.join(' '));
    await receiptCommand(mockChalk, [String(slowRow.id)]);
    console.log = origLog;

    const body = lines.join('\n');
    expect(body).toContain('slower than target');
  });

  it('shows error status and hint for failed requests', async () => {
    const { receiptCommand } = await import('../src/commands/receipts.js');
    const all = await readRecentRequests({ limit: 10 });
    const errorRow = all.find(r => r.status_code === 429);

    const lines = [];
    const mockChalk = new Proxy({}, { get: (_, p) => typeof p === 'string' ? (s = '') => s : undefined });
    const origLog = console.log; console.log = (...a) => lines.push(a.join(' '));
    await receiptCommand(mockChalk, [String(errorRow.id)]);
    console.log = origLog;

    const body = lines.join('\n').toLowerCase();
    expect(body).toContain('429');
    expect(body).toContain('rate limited');
  });

  it('shows fallback route as preferred → actual tier', async () => {
    const { receiptCommand } = await import('../src/commands/receipts.js');
    const all = await readRecentRequests({ limit: 10 });
    const fallbackRow = all.find(r => r.route_fallback_used); // mid → premium

    const lines = [];
    const mockChalk = new Proxy({}, { get: (_, p) => typeof p === 'string' ? (s = '') => s : undefined });
    const origLog = console.log; console.log = (...a) => lines.push(a.join(' '));
    await receiptCommand(mockChalk, [String(fallbackRow.id)]);
    console.log = origLog;

    const body = lines.join('\n');
    expect(body).toContain('→');        // OSS cloud → Premium
    expect(body.toLowerCase()).toContain('oss cloud');
    expect(body.toLowerCase()).toContain('premium');
  });

  it('sets exitCode=1 for a missing id', async () => {
    const { receiptCommand } = await import('../src/commands/receipts.js');
    const origCode = process.exitCode;
    const mockChalk = new Proxy({}, { get: (_, p) => typeof p === 'string' ? (s = '') => s : undefined });
    const origErr = console.error; console.error = () => {};
    await receiptCommand(mockChalk, ['999999']);
    console.error = origErr;
    expect(process.exitCode).toBe(1);
    process.exitCode = origCode;
  });

  it('sets exitCode=1 for a non-numeric id', async () => {
    const { receiptCommand } = await import('../src/commands/receipts.js');
    const origCode = process.exitCode;
    const mockChalk = new Proxy({}, { get: (_, p) => typeof p === 'string' ? (s = '') => s : undefined });
    const origErr = console.error; console.error = () => {};
    const origLog = console.log; console.log = () => {};
    await receiptCommand(mockChalk, ['abc']);
    console.error = origErr; console.log = origLog;
    expect(process.exitCode).toBe(1);
    process.exitCode = origCode;
  });
});

// ── dashboardCommand ──────────────────────────────────────────────────────

describe('dashboardCommand', () => {
  it('prints the dashboard URL', async () => {
    const { dashboardCommand, DASHBOARD_URL } = await import('../src/commands/dashboard.js');
    const lines = [];
    const mockChalk = new Proxy({}, { get: (_, p) => typeof p === 'string' ? (s = '') => s : undefined });
    const origLog = console.log; console.log = (...a) => lines.push(a.join(' '));
    dashboardCommand(mockChalk);
    console.log = origLog;
    expect(lines.join('\n')).toContain('aibadgr.com/dashboard');
    expect(DASHBOARD_URL).toContain('aibadgr.com/dashboard');
  });

  it('exports DASHBOARD_URL as a string', async () => {
    const { DASHBOARD_URL } = await import('../src/commands/dashboard.js');
    expect(typeof DASHBOARD_URL).toBe('string');
    expect(DASHBOARD_URL.startsWith('https://')).toBe(true);
  });
});

// ── monitor helpers (unit) ────────────────────────────────────────────────

describe('monitor helpers', () => {
  it('monitorCommand is exported from monitor.js', async () => {
    const mod = await import('../src/commands/monitor.js');
    expect(typeof mod.monitorCommand).toBe('function');
  });
});

// ── charge_status persistence ─────────────────────────────────────────────

describe('charge_status persistence', () => {
  it('stores confirmed_usage_reported for the openclaw row', async () => {
    const rows = await readRecentRequests({ limit: 10 });
    const confirmed = rows.find(r => r.client === 'openclaw');
    expect(confirmed).toBeDefined();
    expect(confirmed.charge_status).toBe('confirmed_usage_reported');
    expect(confirmed.stream_completed).toBeTruthy();
    expect(confirmed.provider_usage_reported).toBeTruthy();
    expect(confirmed.output_tokens_received).toBe(420);
  });

  it('stores potentially_charged for the disconnected cursor row', async () => {
    const rows = await readRecentRequests({ limit: 10 });
    const row = rows.find(r => r.client === 'cursor');
    expect(row).toBeDefined();
    expect(row.charge_status).toBe('potentially_charged');
    expect(row.client_disconnected).toBeTruthy();
    expect(row.stream_completed).toBeFalsy();
    expect(row.provider_request_id).toBe('req_abc123xyz');
  });

  it('stores null charge_status for rows that predate the feature', async () => {
    const rows = await readRecentRequests({ limit: 10 });
    const old = rows.find(r => r.client === 'cline');
    expect(old).toBeDefined();
    // charge_status was not provided — should be null or falsy
    expect(old.charge_status == null || old.charge_status === '').toBe(true);
  });
});

// ── receiptCommand --export ───────────────────────────────────────────────

describe('receiptCommand --export', () => {
  it('prints a plain-text support bundle with all evidence fields', async () => {
    const { receiptCommand } = await import('../src/commands/receipts.js');
    const rows = await readRecentRequests({ limit: 10 });
    const row = rows.find(r => r.client === 'cursor');

    const lines = [];
    const mockChalk = new Proxy({}, { get: (_, p) => typeof p === 'string' ? (s = '') => s : undefined });
    const origLog = console.log; console.log = (...a) => lines.push(a.join(' '));
    await receiptCommand(mockChalk, [String(row.id), '--export']);
    console.log = origLog;

    const body = lines.join('\n');
    expect(body).toContain('Support Bundle');
    expect(body).toContain('Potentially charged');
    expect(body).toContain('req_abc123xyz');
    expect(body).toContain('Provider request ID');
    expect(body.toLowerCase()).toContain('client disconnected');
    expect(body).toContain('Stream completed');
  });

  it('export output contains no chalk color codes', async () => {
    const { receiptCommand } = await import('../src/commands/receipts.js');
    const rows = await readRecentRequests({ limit: 10 });
    const row = rows.find(r => r.client === 'cursor');

    const lines = [];
    const mockChalk = new Proxy({}, { get: (_, p) => typeof p === 'string' ? (s = '') => s : undefined });
    const origLog = console.log; console.log = (...a) => lines.push(a.join(' '));
    await receiptCommand(mockChalk, [String(row.id), '--export']);
    console.log = origLog;

    // With our no-op chalk mock, output should be pure text
    const body = lines.join('\n');
    expect(body).not.toMatch(/\x1b\[/); // no ANSI escape sequences
  });
});

// ── receiptCommand context health display ────────────────────────────────

describe('receiptCommand context health display', () => {
  async function getReceiptOutput(requestLog) {
    const { saveRequestLog: save, readRecentRequests: recent } = await import('../src/db.js');
    const { receiptCommand } = await import('../src/commands/receipts.js');
    await save(requestLog);
    const rows = await recent({ limit: 1 });
    const lines = [];
    const mockChalk = new Proxy({}, {
      get: (_, p) => {
        if (['bold', 'dim', 'green', 'cyan', 'yellow', 'red', 'blue'].includes(p)) return (s) => s;
        return undefined;
      },
    });
    const origLog = console.log; console.log = (...a) => lines.push(a.join(' '));
    await receiptCommand(mockChalk, [String(rows[0].id)]);
    console.log = origLog;
    return lines.join('\n');
  }

  it('shows "compact now" when context_used_percent >= 75', async () => {
    const body = await getReceiptOutput({
      model: 'gpt-4o', originalTokens: 100, optimizedTokens: 100,
      tokensSaved: 0, savedPercent: 0, estimatedSavingsUsd: 0,
      actualCostUsd: 0, cachedTokens: 0, contextTokensRemoved: 0,
      estimatedSavingsVsHaiku: 0, estimatedSavingsVsSonnet: 0,
      estimatedCacheEligibleTokens: 0, clientProfile: 'coding',
      latencyMs: 100, statusCode: 200, routeTier: 'mid', preferredTier: 'mid',
      routeReason: 'test', routeFallbackUsed: false,
      latencyTargetMs: 5000, didDedupe: false, didCompress: false, streaming: false,
      contextUsedPercent: 80,
    });
    expect(body).toMatch(/compact now/i);
  });

  it('shows "compact soon" when context_used_percent is 60–74', async () => {
    const body = await getReceiptOutput({
      model: 'gpt-4o', originalTokens: 100, optimizedTokens: 100,
      tokensSaved: 0, savedPercent: 0, estimatedSavingsUsd: 0,
      actualCostUsd: 0, cachedTokens: 0, contextTokensRemoved: 0,
      estimatedSavingsVsHaiku: 0, estimatedSavingsVsSonnet: 0,
      estimatedCacheEligibleTokens: 0, clientProfile: 'coding',
      latencyMs: 100, statusCode: 200, routeTier: 'mid', preferredTier: 'mid',
      routeReason: 'test', routeFallbackUsed: false,
      latencyTargetMs: 5000, didDedupe: false, didCompress: false, streaming: false,
      contextUsedPercent: 65,
    });
    expect(body).toMatch(/compact soon/i);
  });

  it('shows no compaction warning when context_used_percent < 60', async () => {
    const body = await getReceiptOutput({
      model: 'gpt-4o', originalTokens: 100, optimizedTokens: 100,
      tokensSaved: 0, savedPercent: 0, estimatedSavingsUsd: 0,
      actualCostUsd: 0, cachedTokens: 0, contextTokensRemoved: 0,
      estimatedSavingsVsHaiku: 0, estimatedSavingsVsSonnet: 0,
      estimatedCacheEligibleTokens: 0, clientProfile: 'coding',
      latencyMs: 100, statusCode: 200, routeTier: 'mid', preferredTier: 'mid',
      routeReason: 'test', routeFallbackUsed: false,
      latencyTargetMs: 5000, didDedupe: false, didCompress: false, streaming: false,
      contextUsedPercent: 40,
    });
    expect(body).toContain('Context used');
    expect(body).not.toMatch(/compact now/i);
    expect(body).not.toMatch(/compact soon/i);
  });
});
