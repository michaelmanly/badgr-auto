#!/usr/bin/env node
/**
 * Badgr Token Proxy — OpenAI-compatible proxy (default http://localhost:8787/v1).
 * Dedupes/compresses context, routes to cheapest tier, logs token savings.
 * Supports streaming (text/event-stream) and buffered JSON responses.
 */

import http from 'node:http';
import { Readable } from 'node:stream';
import { loadConfig, DEFAULT_UPSTREAM_BASE_URL } from './config.js';
import { loadProxyConfig, PROXY_PORT } from './proxy-config.js';
import { countTokens } from './token-counter.js';
import { optimizeMessages } from './optimizer.js';
import { estimateSavings, estimateHaikuCost, estimateSonnetCost } from './pricing.js';
import { saveRequestLog } from './db.js';
import { routeRequest } from './router.js';
import { trackRequest, trackError } from './analytics.js';

function pushSavingsToBackend(entry) {
  const config = loadConfig();
  if (!config.apiKey || !config.baseUrl) return;
  const backendBase = config.baseUrl.replace(/\/v1\/?$/, '');
  fetch(`${backendBase}/v1/proxy/savings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: entry.model,
      original_tokens: entry.originalTokens,
      optimized_tokens: entry.optimizedTokens,
      tokens_saved: entry.tokensSaved,
      saved_percent: entry.savedPercent,
      estimated_savings_usd: entry.estimatedSavingsUsd,
      cached_tokens: entry.cachedTokens,
      client_profile: entry.clientProfile,
      route_tier: entry.routeTier,
      latency_ms: entry.latencyMs,
      streaming: entry.streaming,
    }),
    signal: AbortSignal.timeout(4000),
  }).catch(() => { /* fire-and-forget — never blocks responses */ });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function jsonResponse(res, statusCode, body, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(statusCode, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function extractBearer(headers = {}) {
  const auth = headers.authorization || headers.Authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  return '';
}

function isDirectOpenAiUpstream(baseUrl) {
  try {
    return new URL(baseUrl).hostname === 'api.openai.com';
  } catch {
    return false;
  }
}

function getUpstreamApiKey(baseUrl, reqHeaders = {}) {
  const clientKey = extractBearer(reqHeaders);
  const badgrKey =
    loadConfig().apiKey ||
    process.env.BADGR_AUTO_API_KEY ||
    process.env.BADGR_API_KEY ||
    '';
  if (isDirectOpenAiUpstream(baseUrl)) {
    return process.env.OPENAI_API_KEY || clientKey || badgrKey || '';
  }
  return clientKey || badgrKey || '';
}

function getUpstreamBaseUrl(proxyConfig, overrideBaseUrl) {
  return (
    overrideBaseUrl ||
    proxyConfig.upstreamBaseUrl ||
    proxyConfig.midBaseUrl ||
    DEFAULT_UPSTREAM_BASE_URL
  ).replace(/\/+$/, '');
}

function upstreamHeaders(reqHeaders = {}, baseUrl) {
  const key = getUpstreamApiKey(baseUrl, reqHeaders);
  return {
    'content-type': 'application/json',
    ...(key ? { authorization: `Bearer ${key}` } : {}),
    ...(reqHeaders['anthropic-version'] ? { 'anthropic-version': reqHeaders['anthropic-version'] } : {}),
  };
}

async function forwardJson(path, body, reqHeaders = {}, overrideBaseUrl) {
  const proxyConfig = loadProxyConfig();
  const base = getUpstreamBaseUrl(proxyConfig, overrideBaseUrl);
  const isGet = body === undefined;
  const response = await fetch(`${base}${path}`, {
    method: isGet ? 'GET' : 'POST',
    headers: {
      accept: 'application/json',
      ...upstreamHeaders(reqHeaders, base),
      ...(isGet ? {} : {}),
    },
    body: isGet ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: response.status, data };
}

async function forwardStream(path, body, reqHeaders, overrideBaseUrl, signal) {
  const proxyConfig = loadProxyConfig();
  const base = getUpstreamBaseUrl(proxyConfig, overrideBaseUrl);
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { ...upstreamHeaders(reqHeaders, base), accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });
}

const TIER_LABELS = {
  edge:    'local model',
  mid:     'mid-tier OSS',
  async:   'async GPU',
  premium: 'premium (Claude)',
};

function logSavings(entry) {
  const tierLabel = TIER_LABELS[entry.routeTier] || entry.routeTier || 'unknown';
  const fallback = entry.routeFallbackUsed ? ` (fallback from ${entry.preferredTier})` : '';
  const isLocal = entry.routeTier === 'edge';
  const actualCost = entry.actualCostUsd;
  const sonnetCost = estimateSonnetCost(entry.optimizedTokens);
  const savedVsSonnet = Math.max(sonnetCost - actualCost, 0);

  const lines = [];

  // 1. Context optimization
  const removed = entry.contextTokensRemoved ?? entry.tokensSaved;
  if (removed > 0) {
    lines.push(`✓ Context optimization: ${removed.toLocaleString()} tokens safely removed`);
  } else {
    lines.push(`✓ Context optimization: no changes (${entry.originalTokens.toLocaleString()} tokens)`);
  }

  // 2. Prompt caching — only report when upstream confirms it
  if (typeof entry.cachedTokens === 'number' && entry.cachedTokens > 0) {
    lines.push(`✓ Prompt caching: ${entry.cachedTokens.toLocaleString()} cached input tokens (upstream)`);
  } else if (!entry.streaming) {
    lines.push(`✓ Prompt caching: none reported by upstream`);
  }

  // 3. Routing savings
  lines.push(
    isLocal
      ? `✓ Routing savings: $0.00 cloud cost (local model)`
      : `✓ Routing savings: $${savedVsSonnet.toFixed(4)} estimated saved vs Claude Sonnet`,
  );
  lines.push(`✓ Actual route: ${tierLabel}${fallback}`);
  lines.push(`✓ Latency: ${entry.latencyMs}ms${entry.streaming ? ' (stream)' : ''}`);

  process.stderr.write(lines.join('\n') + '\n');
}

function buildBadgrHeaders(originalTokens, optimizedTokens, savings, route, cachedTokens) {
  return {
    'x-badgr-original-tokens': String(originalTokens),
    'x-badgr-optimized-tokens': String(optimizedTokens),
    'x-badgr-tokens-saved': String(savings.savedTokens),
    'x-badgr-route-tier': route.selectedTier,
    'x-badgr-preferred-tier': route.preferredTier,
    'x-badgr-cached-tokens': String(cachedTokens ?? 0),
  };
}

// Parse cached token count from the upstream provider's response usage object.
// OpenAI: usage.prompt_tokens_details.cached_tokens
// Anthropic-style: usage.cache_read_input_tokens
// Returns 0 when not present (do not claim savings without confirmed metadata).
function extractCachedTokens(responseData) {
  const cached = responseData?.usage?.prompt_tokens_details?.cached_tokens;
  if (typeof cached === 'number') return cached;
  const anthropicCached = responseData?.usage?.cache_read_input_tokens;
  if (typeof anthropicCached === 'number') return anthropicCached;
  return 0;
}

function buildLogEntry(fields) {
  const isLocal = fields.route.selectedTier === 'edge';
  const actualCostUsd = isLocal ? 0 : fields.savings.optimizedCost;
  return {
    model: fields.model,
    originalTokens: fields.originalTokens,
    optimizedTokens: fields.optimizedTokens,
    tokensSaved: fields.savings.savedTokens,
    savedPercent: fields.savings.savedPercent,
    estimatedSavingsUsd: fields.savings.savedCost,
    actualCostUsd,
    cachedTokens: fields.cachedTokens ?? 0,
    clientProfile: fields.optimized.clientProfile,
    contextTokensRemoved: fields.optimized.contextTokensRemoved ?? fields.savings.savedTokens,
    latencyMs: fields.latencyMs,
    statusCode: fields.statusCode,
    routeTier: fields.route.selectedTier,
    preferredTier: fields.route.preferredTier,
    routeReason: fields.route.reason,
    routeFallbackUsed: fields.route.fallbackUsed,
    latencyTargetMs: fields.route.latencyTargetMs,
    didDedupe: fields.optimized.didDedupe,
    didCompress: fields.optimized.didCompress,
    streaming: fields.streaming,
  };
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  const method = req.method || 'GET';

  // ── Health ──────────────────────────────────────────────────────────────────
  if (method === 'GET' && url === '/health') {
    jsonResponse(res, 200, { status: 'ok', proxy: 'badgr-token-proxy', base_url: `http://localhost:${PROXY_PORT}/v1` });
    return;
  }

  // ── Models ───────────────────────────────────────────────────────────────────
  if (method === 'GET' && url === '/v1/models') {
    try {
      const upstream = await forwardJson('/models', undefined, req.headers);
      jsonResponse(res, upstream.status, upstream.data);
    } catch {
      jsonResponse(res, 200, {
        object: 'list',
        data: [{ id: 'badgr-token-proxy', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'badgr' }],
      });
    }
    return;
  }

  // ── Chat completions ─────────────────────────────────────────────────────────
  if (method === 'POST' && url === '/v1/chat/completions') {
    let requestData;
    try {
      requestData = JSON.parse(await readBody(req));
    } catch {
      jsonResponse(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } });
      return;
    }

    const proxyConfig = loadProxyConfig();
    const route = routeRequest(requestData, proxyConfig);
    const model = route.model || requestData.model || 'gpt-4o-mini';
    const startedAt = Date.now();

    const originalTokens = countTokens(requestData.messages || [], model);
    const optimized = optimizeMessages(requestData.messages || [], { ...proxyConfig, model, requestData });
    const optimizedRequest = { ...requestData, model, messages: optimized.messages };
    const optimizedTokens = countTokens(optimizedRequest.messages || [], model);
    const savings = estimateSavings(originalTokens, optimizedTokens, model);

    // ── Streaming path ────────────────────────────────────────────────────────
    if (requestData.stream) {
      const abort = new AbortController();
      req.on('close', () => abort.abort());

      let upstreamResponse;
      try {
        upstreamResponse = await forwardStream('/chat/completions', optimizedRequest, req.headers, route.baseUrl, abort.signal);
      } catch (err) {
        const msg = abort.signal.aborted ? 'Client disconnected before upstream responded' : err.message;
        jsonResponse(res, 502, { error: { message: msg, type: 'proxy_error' } });
        return;
      }

      // Non-2xx: return error as JSON, not a broken stream
      if (!upstreamResponse.ok) {
        const errText = await upstreamResponse.text().catch(() => '');
        let errData;
        try { errData = errText ? JSON.parse(errText) : {}; } catch { errData = { error: { message: errText, type: 'upstream_error' } }; }
        if (upstreamResponse.status >= 500) {
          trackError({ routeTier: route.selectedTier, model, statusCode: upstreamResponse.status, errorType: 'upstream_error', streaming: true, latencyMs: Date.now() - startedAt });
        }
        jsonResponse(res, upstreamResponse.status, errData);
        return;
      }

      if (!upstreamResponse.body) {
        jsonResponse(res, 502, { error: { message: 'Upstream returned no body', type: 'proxy_error' } });
        return;
      }

      // Streaming: cached tokens cannot be determined without buffering. Log as 0.
      const streamBadgrHdrs = buildBadgrHeaders(originalTokens, optimizedTokens, savings, route, 0);
      res.writeHead(upstreamResponse.status, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...streamBadgrHdrs,
      });

      let firstChunkAt = 0;
      try {
        // Readable.fromWeb gives us reliable async iteration on Node 18+
        for await (const chunk of Readable.fromWeb(upstreamResponse.body)) {
          if (!firstChunkAt) firstChunkAt = Date.now();
          if (!res.writableEnded) res.write(chunk);
        }
      } catch (err) {
        // Upstream or client disconnected mid-stream — not fatal
        if (!abort.signal.aborted) {
          process.stderr.write(`[badgr-token-proxy] Stream interrupted: ${err.message}\n`);
        }
      } finally {
        if (!res.writableEnded) res.end();
      }

      const latencyMs = firstChunkAt ? firstChunkAt - startedAt : Date.now() - startedAt;
      const entry = buildLogEntry({ model, originalTokens, optimizedTokens, savings, route, optimized, cachedTokens: 0, latencyMs, statusCode: upstreamResponse.status, streaming: true });
      logSavings(entry);
      await saveRequestLog(entry);
      pushSavingsToBackend(entry);
      trackRequest(entry);
      return;
    }

    // ── Buffered JSON path ────────────────────────────────────────────────────
    let statusCode = 502;
    let upstreamData;
    try {
      const upstream = await forwardJson('/chat/completions', optimizedRequest, req.headers, route.baseUrl);
      statusCode = upstream.status;
      upstreamData = upstream.data;
    } catch (err) {
      upstreamData = { error: { message: err.message, type: 'proxy_error' } };
    }

    const cachedTokens = extractCachedTokens(upstreamData);
    const latencyMs = Date.now() - startedAt;
    const entry = buildLogEntry({ model, originalTokens, optimizedTokens, savings, route, optimized, cachedTokens, latencyMs, statusCode, streaming: false });
    logSavings(entry);
    await saveRequestLog(entry);
    pushSavingsToBackend(entry);
    trackRequest(entry);
    if (statusCode >= 500) {
      trackError({ routeTier: route.selectedTier, model, statusCode, errorType: 'upstream_error', streaming: false, latencyMs });
    }
    const bufferedBadgrHdrs = buildBadgrHeaders(originalTokens, optimizedTokens, savings, route, cachedTokens);
    jsonResponse(res, statusCode, upstreamData, bufferedBadgrHdrs);
    return;
  }

  jsonResponse(res, 404, { error: { message: 'Not found', type: 'not_found' } });
});

export { server };

// Auto-start when run directly (node proxy-server.js / badgr-auto start).
import { fileURLToPath } from 'node:url';
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  server.listen(PROXY_PORT, '127.0.0.1', () => {
    process.stderr.write(`[badgr-token-proxy] Listening on http://localhost:${PROXY_PORT}/v1\n`);
  });
  server.on('error', (err) => {
    process.stderr.write(`[badgr-token-proxy] Server error: ${err.message}\n`);
    process.exit(1);
  });
}
