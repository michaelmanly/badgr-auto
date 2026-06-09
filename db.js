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
    // Migrate existing tables that are missing the streaming column.
    try {
      db.exec('ALTER TABLE request_logs ADD COLUMN streaming INTEGER NOT NULL DEFAULT 0');
    } catch {
      // Column already exists — expected on fresh installs.
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
  };

  try {
    const db = await initDatabase();
    if (db) {
      db.prepare(`
        INSERT INTO request_logs (
          created_at, model, original_tokens, optimized_tokens, tokens_saved,
          saved_percent, estimated_savings_usd, latency_ms, status_code, route_tier,
          preferred_tier, route_reason, route_fallback_used, latency_target_ms,
          deduped, compressed, streaming
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.created_at, row.model, row.original_tokens, row.optimized_tokens,
        row.tokens_saved, row.saved_percent, row.estimated_savings_usd,
        row.latency_ms, row.status_code, row.route_tier, row.preferred_tier,
        row.route_reason, row.route_fallback_used, row.latency_target_ms,
        row.deduped, row.compressed, row.streaming,
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
          COALESCE(SUM(estimated_savings_usd), 0) AS total_usd,
          COALESCE(AVG(saved_percent), 0) AS avg_saved_pct,
          COALESCE(AVG(latency_ms), 0) AS avg_latency_ms,
          COALESCE(SUM(CASE WHEN route_tier = 'edge' THEN 1 ELSE 0 END), 0) AS local_count,
          COALESCE(SUM(CASE WHEN route_tier = 'mid' THEN 1 ELSE 0 END), 0) AS mid_count,
          COALESCE(SUM(CASE WHEN route_tier = 'async' THEN 1 ELSE 0 END), 0) AS async_count,
          COALESCE(SUM(CASE WHEN route_tier = 'premium' THEN 1 ELSE 0 END), 0) AS premium_count
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

function readStatsFromJsonl(cutoff) {
  const zero = { requests: 0, total_original: 0, total_optimized: 0, total_saved: 0, total_usd: 0, avg_saved_pct: 0, avg_latency_ms: 0 };
  if (!existsSync(REQUEST_LOG_JSONL)) return zero;

  const lines = readFileSync(REQUEST_LOG_JSONL, 'utf8').trim().split('\n').filter(Boolean);
  const rows = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const filtered = cutoff ? rows.filter(r => new Date(r.created_at) >= cutoff) : rows;

  if (filtered.length === 0) return { ...zero, local_count: 0, mid_count: 0, async_count: 0, premium_count: 0, local_pct: 0, mid_pct: 0, async_pct: 0, premium_pct: 0 };

  const totals = filtered.reduce((acc, r) => {
    acc.total_original += r.original_tokens || 0;
    acc.total_optimized += r.optimized_tokens || 0;
    acc.total_saved += r.tokens_saved || 0;
    acc.total_usd += r.estimated_savings_usd || 0;
    acc.avg_saved_pct += r.saved_percent || 0;
    acc.avg_latency_ms += r.latency_ms || 0;
    acc.local_count   += (r.route_tier === 'edge'    ? 1 : 0);
    acc.mid_count     += (r.route_tier === 'mid'     ? 1 : 0);
    acc.async_count   += (r.route_tier === 'async'   ? 1 : 0);
    acc.premium_count += (r.route_tier === 'premium' ? 1 : 0);
    return acc;
  }, { ...zero, local_count: 0, mid_count: 0, async_count: 0, premium_count: 0 });

  totals.requests = filtered.length;
  totals.avg_saved_pct = totals.avg_saved_pct / filtered.length;
  totals.avg_latency_ms = totals.avg_latency_ms / filtered.length;
  return addTierPcts(totals);
}
