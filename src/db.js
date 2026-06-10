import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR } from './config.js';

export const REQUEST_LOG_DB   = join(CONFIG_DIR, 'auto-requests.sqlite');
export const REQUEST_LOG_JSONL = join(CONFIG_DIR, 'auto-requests.jsonl');

let sqlite;
let initialized = false;

async function getSqlite() {
  if (sqlite !== undefined) return sqlite;
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (major < 22) { sqlite = null; return sqlite; }
  sqlite = await import('node:sqlite');
  return sqlite;
}

async function initDatabase() {
  const module = await getSqlite();
  if (!module) return null;
  const db = new module.DatabaseSync(REQUEST_LOG_DB);
  if (!initialized) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS request_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        model TEXT,
        original_tokens INTEGER NOT NULL,
        optimized_tokens INTEGER NOT NULL,
        tokens_saved INTEGER NOT NULL,
        saved_percent REAL NOT NULL,
        estimated_savings_usd REAL NOT NULL,
        latency_ms INTEGER NOT NULL,
        status_code INTEGER,
        route_tier TEXT,
        preferred_tier TEXT,
        route_reason TEXT,
        route_fallback_used INTEGER NOT NULL DEFAULT 0,
        latency_target_ms INTEGER,
        deduped INTEGER NOT NULL,
        compressed INTEGER NOT NULL,
        streaming INTEGER NOT NULL DEFAULT 0
      )
    `);
    // Migrate existing tables that are missing columns added after initial release.
    for (const migration of [
      'ALTER TABLE request_logs ADD COLUMN streaming INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE request_logs ADD COLUMN actual_cost_usd REAL NOT NULL DEFAULT 0',
      'ALTER TABLE request_logs ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE request_logs ADD COLUMN client_profile TEXT',
      'ALTER TABLE request_logs ADD COLUMN context_tokens_removed INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE request_logs ADD COLUMN estimated_savings_vs_haiku REAL NOT NULL DEFAULT 0',
      'ALTER TABLE request_logs ADD COLUMN estimated_savings_vs_sonnet REAL NOT NULL DEFAULT 0',
      'ALTER TABLE request_logs ADD COLUMN estimated_cache_eligible_tokens INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE request_logs ADD COLUMN client TEXT',
      'ALTER TABLE request_logs ADD COLUMN actual_route TEXT',
      'ALTER TABLE request_logs ADD COLUMN provider_request_id TEXT',
      'ALTER TABLE request_logs ADD COLUMN started_at TEXT',
      'ALTER TABLE request_logs ADD COLUMN ended_at TEXT',
      'ALTER TABLE request_logs ADD COLUMN stream_completed INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE request_logs ADD COLUMN client_disconnected INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE request_logs ADD COLUMN timed_out INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE request_logs ADD COLUMN output_tokens_received INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE request_logs ADD COLUMN provider_usage_reported INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE request_logs ADD COLUMN charge_status TEXT',
    ]) {
      try { db.exec(migration); } catch { /* column already exists */ }
    }
    initialized = true;
  }
  return db;
}

export async function saveRequestLog(entry) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const row = {
    created_at: new Date().toISOString(),
    model: entry.model || null,
    original_tokens: entry.originalTokens,
    optimized_tokens: entry.optimizedTokens,
    tokens_saved: entry.tokensSaved,
    saved_percent: entry.savedPercent,
    estimated_savings_usd: entry.estimatedSavingsUsd,
    actual_cost_usd: entry.actualCostUsd ?? 0,
    cached_tokens: entry.cachedTokens ?? 0,
    context_tokens_removed: entry.contextTokensRemoved ?? 0,
    estimated_savings_vs_haiku: entry.estimatedSavingsVsHaiku ?? 0,
    estimated_savings_vs_sonnet: entry.estimatedSavingsVsSonnet ?? 0,
    estimated_cache_eligible_tokens: entry.estimatedCacheEligibleTokens ?? 0,
    client_profile: entry.clientProfile || null,
    latency_ms: entry.latencyMs,
    status_code: entry.statusCode ?? null,
    route_tier: entry.routeTier || null,
    preferred_tier: entry.preferredTier || null,
    route_reason: entry.routeReason || null,
    route_fallback_used: entry.routeFallbackUsed ? 1 : 0,
    latency_target_ms: entry.latencyTargetMs ?? null,
    deduped: entry.didDedupe ? 1 : 0,
    compressed: entry.didCompress ? 1 : 0,
    streaming: entry.streaming ? 1 : 0,
    client: entry.client || null,
    actual_route: entry.actualRoute || null,
    provider_request_id: entry.providerRequestId || null,
    started_at: entry.startedAt || null,
    ended_at: entry.endedAt || null,
    stream_completed: entry.streamCompleted ? 1 : 0,
    client_disconnected: entry.clientDisconnected ? 1 : 0,
    timed_out: entry.timedOut ? 1 : 0,
    output_tokens_received: entry.outputTokensReceived ?? 0,
    provider_usage_reported: entry.providerUsageReported ? 1 : 0,
    charge_status: entry.chargeStatus || null,
  };

  try {
    const db = await initDatabase();
    if (db) {
      db.prepare(`
        INSERT INTO request_logs (
          created_at, model, original_tokens, optimized_tokens, tokens_saved,
          saved_percent, estimated_savings_usd, actual_cost_usd, cached_tokens,
          context_tokens_removed, estimated_savings_vs_haiku, estimated_savings_vs_sonnet,
          estimated_cache_eligible_tokens, client_profile,
          latency_ms, status_code, route_tier,
          preferred_tier, route_reason, route_fallback_used, latency_target_ms,
          deduped, compressed, streaming, client, actual_route,
          provider_request_id, started_at, ended_at,
          stream_completed, client_disconnected, timed_out,
          output_tokens_received, provider_usage_reported, charge_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.created_at, row.model, row.original_tokens, row.optimized_tokens,
        row.tokens_saved, row.saved_percent, row.estimated_savings_usd,
        row.actual_cost_usd, row.cached_tokens,
        row.context_tokens_removed, row.estimated_savings_vs_haiku, row.estimated_savings_vs_sonnet,
        row.estimated_cache_eligible_tokens, row.client_profile,
        row.latency_ms, row.status_code, row.route_tier, row.preferred_tier,
        row.route_reason, row.route_fallback_used, row.latency_target_ms,
        row.deduped, row.compressed, row.streaming, row.client, row.actual_route,
        row.provider_request_id, row.started_at, row.ended_at,
        row.stream_completed, row.client_disconnected, row.timed_out,
        row.output_tokens_received, row.provider_usage_reported, row.charge_status,
      );
      db.close();
      return { path: REQUEST_LOG_DB, format: 'sqlite' };
    }
  } catch {
    // Fall back to JSONL when node:sqlite is unavailable or disabled.
  }

  const existed = existsSync(REQUEST_LOG_JSONL);
  appendFileSync(REQUEST_LOG_JSONL, `${JSON.stringify(row)}\n`, { mode: existed ? undefined : 0o600 });
  return { path: REQUEST_LOG_JSONL, format: 'jsonl' };
}

/**
 * Read aggregated savings stats from the local log.
 * period: '1d' | '7d' | 'all'
 */
export async function readSavingsStats(period = 'all') {
  const cutoff = periodCutoff(period);

  try {
    const module = await getSqlite();
    if (module && existsSync(REQUEST_LOG_DB)) {
      const db = new module.DatabaseSync(REQUEST_LOG_DB);
      const where = cutoff ? `WHERE created_at >= '${cutoff.toISOString()}'` : '';
      const row = db.prepare(`
        SELECT
          COUNT(*) AS requests,
          COALESCE(SUM(original_tokens), 0) AS total_original,
          COALESCE(SUM(optimized_tokens), 0) AS total_optimized,
          COALESCE(SUM(tokens_saved), 0) AS total_saved,
          COALESCE(SUM(context_tokens_removed), 0) AS total_context_tokens_removed,
          COALESCE(SUM(estimated_savings_usd), 0) AS total_usd,
          COALESCE(SUM(actual_cost_usd), 0) AS total_actual_cost,
          COALESCE(SUM(cached_tokens), 0) AS total_cached,
          COALESCE(SUM(estimated_cache_eligible_tokens), 0) AS total_estimated_cache_eligible,
          COALESCE(SUM(estimated_savings_vs_haiku), 0) AS total_saved_vs_haiku,
          COALESCE(SUM(estimated_savings_vs_sonnet), 0) AS total_saved_vs_sonnet,
          COALESCE(AVG(saved_percent), 0) AS avg_saved_pct,
          COALESCE(AVG(latency_ms), 0) AS avg_latency_ms,
          COALESCE(SUM(CASE WHEN route_tier = 'edge' THEN 1 ELSE 0 END), 0) AS local_count,
          COALESCE(SUM(CASE WHEN route_tier = 'mid' THEN 1 ELSE 0 END), 0) AS mid_count,
          COALESCE(SUM(CASE WHEN route_tier = 'async' THEN 1 ELSE 0 END), 0) AS async_count,
          COALESCE(SUM(CASE WHEN route_tier = 'premium' THEN 1 ELSE 0 END), 0) AS premium_count,
          COALESCE(SUM(route_fallback_used), 0) AS fallbacks_used
        FROM request_logs ${where}
      `).get();
      db.close();
      return addTierPcts(row);
    }
  } catch {
    // Fall through to JSONL reader.
  }

  return readStatsFromJsonl(cutoff);
}

function addTierPcts(row) {
  const total = row.requests || 1;
  return {
    ...row,
    local_pct:   Math.round(((row.local_count || 0) / total) * 100),
    mid_pct:     Math.round(((row.mid_count || 0) / total) * 100),
    async_pct:   Math.round(((row.async_count || 0) / total) * 100),
    premium_pct: Math.round(((row.premium_count || 0) / total) * 100),
  };
}

function periodCutoff(period) {
  if (period === 'all' || !period) return null;
  const days = Number.parseInt(period.replace('d', ''), 10);
  if (!Number.isFinite(days)) return null;
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

/**
 * Read recent request rows for the receipts list.
 * options: { limit = 20, period = 'all' }
 * Returns array of row objects (newest first).
 */
export async function readRecentRequests({ limit = 20, period = 'all', failed = false, fallback = false } = {}) {
  const cutoff = periodCutoff(period);
  const conditions = [];
  if (cutoff) conditions.push(`created_at >= '${cutoff.toISOString()}'`);
  if (failed) conditions.push('status_code >= 400');
  if (fallback) conditions.push('route_fallback_used = 1');
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  try {
    const module = await getSqlite();
    if (module && existsSync(REQUEST_LOG_DB)) {
      const db = new module.DatabaseSync(REQUEST_LOG_DB);
      const rows = db.prepare(
        `SELECT * FROM request_logs ${where} ORDER BY id DESC LIMIT ?`
      ).all(limit);
      db.close();
      return rows;
    }
  } catch { /* fall through */ }

  // JSONL fallback — assign 1-based line ids so receipts work without node:sqlite (Node < 22).
  if (!existsSync(REQUEST_LOG_JSONL)) return [];
  const lines = readFileSync(REQUEST_LOG_JSONL, 'utf8').trim().split('\n').filter(Boolean);
  let rows = lines
    .map((line, index) => {
      try { return { ...JSON.parse(line), id: index + 1 }; } catch { return null; }
    })
    .filter(Boolean);
  if (cutoff) rows = rows.filter(r => new Date(r.created_at) >= cutoff);
  if (failed) rows = rows.filter(r => (r.status_code || 200) >= 400);
  if (fallback) rows = rows.filter(r => r.route_fallback_used);
  return rows.slice(-limit).reverse();
}

/**
 * Read a single request row by numeric ID.
 * Returns the row object or null if not found.
 */
export async function readRequestById(id) {
  try {
    const module = await getSqlite();
    if (module && existsSync(REQUEST_LOG_DB)) {
      const db = new module.DatabaseSync(REQUEST_LOG_DB);
      const row = db.prepare('SELECT * FROM request_logs WHERE id = ?').get(id);
      db.close();
      return row ?? null;
    }
  } catch { /* fall through */ }

  // JSONL fallback — id is 1-based line number
  if (!existsSync(REQUEST_LOG_JSONL)) return null;
  const lines = readFileSync(REQUEST_LOG_JSONL, 'utf8').trim().split('\n').filter(Boolean);
  const line = lines[id - 1];
  if (!line) return null;
  try { return { ...JSON.parse(line), id }; } catch { return null; }
}

function readStatsFromJsonl(cutoff) {
  const zero = { requests: 0, total_original: 0, total_optimized: 0, total_saved: 0, total_context_tokens_removed: 0, total_usd: 0, total_actual_cost: 0, total_cached: 0, total_estimated_cache_eligible: 0, total_saved_vs_haiku: 0, total_saved_vs_sonnet: 0, avg_saved_pct: 0, avg_latency_ms: 0, fallbacks_used: 0 };
  if (!existsSync(REQUEST_LOG_JSONL)) return zero;

  const lines = readFileSync(REQUEST_LOG_JSONL, 'utf8').trim().split('\n').filter(Boolean);
  const rows = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const filtered = cutoff ? rows.filter(r => new Date(r.created_at) >= cutoff) : rows;

  if (filtered.length === 0) return { ...zero, local_count: 0, mid_count: 0, async_count: 0, premium_count: 0, local_pct: 0, mid_pct: 0, async_pct: 0, premium_pct: 0 };

  const totals = filtered.reduce((acc, r) => {
    acc.total_original += r.original_tokens || 0;
    acc.total_optimized += r.optimized_tokens || 0;
    acc.total_saved += r.tokens_saved || 0;
    acc.total_context_tokens_removed += r.context_tokens_removed || 0;
    acc.total_usd += r.estimated_savings_usd || 0;
    acc.total_actual_cost += r.actual_cost_usd || 0;
    acc.total_cached += r.cached_tokens || 0;
    acc.total_estimated_cache_eligible += r.estimated_cache_eligible_tokens || 0;
    acc.total_saved_vs_haiku += r.estimated_savings_vs_haiku || 0;
    acc.total_saved_vs_sonnet += r.estimated_savings_vs_sonnet || 0;
    acc.avg_saved_pct += r.saved_percent || 0;
    acc.avg_latency_ms += r.latency_ms || 0;
    acc.local_count   += (r.route_tier === 'edge'    ? 1 : 0);
    acc.mid_count     += (r.route_tier === 'mid'     ? 1 : 0);
    acc.async_count   += (r.route_tier === 'async'   ? 1 : 0);
    acc.premium_count += (r.route_tier === 'premium' ? 1 : 0);
    acc.fallbacks_used += (r.route_fallback_used ? 1 : 0);
    return acc;
  }, { ...zero, local_count: 0, mid_count: 0, async_count: 0, premium_count: 0 });

  totals.requests = filtered.length;
  totals.avg_saved_pct = totals.avg_saved_pct / filtered.length;
  totals.avg_latency_ms = totals.avg_latency_ms / filtered.length;
  return addTierPcts(totals);
}
