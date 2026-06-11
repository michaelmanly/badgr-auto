#!/usr/bin/env node
/**
 * Badgr Token Proxy — OpenAI-compatible proxy (default http://localhost:51999/v1).
 * Dedupes/compresses context, routes to cheapest tier, logs token savings.
 * Supports streaming (text/event-stream) and buffered JSON responses.
 */

import http from 'node:http';
import { Readable } from 'node:stream';
import { loadConfig, DEFAULT_UPSTREAM_BASE_URL } from './config.js';
import { loadProxyConfig, PROXY_PORT, PROXY_PORTS, writeProxyPort } from './proxy-config.js';
import { countTokens } from './token-counter.js';
import { optimizeMessages } from './optimizer.js';
import { estimateSavings, estimateHaikuCost, estimateSonnetCost } from './pricing.js';
import { saveRequestLog, saveEvalPayload } from './db.js';
import { routeRequest } from './router.js';
import { trackRequest, trackError } from './analytics.js';
import { computeContextHealth } from './context-health.js';

function pushSavingsToBackend(entry) {
  const proxyConfig = loadProxyConfig();
  if (!proxyConfig.savingsStats) return;
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

function normalizeOptimizationMode(value) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'off' || normalized === 'none' || normalized === 'disabled') return 'off';
  return undefined;
}

/**
 * Per-request token optimization mode. Does NOT affect routing.
 * Priority: X-Badgr-Mode header → body fields → proxyConfig.tokenOptimization.
 */
export function resolveOptimizationMode(requestData = {}, headers = {}, proxyConfig = {}) {
  const headerMode = normalizeOptimizationMode(headers['x-badgr-mode']);
  if (headerMode) return headerMode;

  const bodyMode = normalizeOptimizationMode(
    requestData.badgr_mode ||
    requestData.badgrMode ||
    requestData.metadata?.mode ||
    requestData.metadata?.badgr_mode,
  );
  if (bodyMode) return bodyMode;

  if (proxyConfig.tokenOptimization === false) return 'off';
  return undefined;
}

function buildOptimizerOptions(proxyConfig, requestData, headers, model) {
  const optimizationMode = resolveOptimizationMode(requestData, headers, proxyConfig);
  return {
    compressionThresholdTokens: proxyConfig.compressionThresholdTokens,
    recentMessagesToKeep: proxyConfig.recentMessagesToKeep,
    summaryMaxTokens: proxyConfig.summaryMaxTokens,
    ...(optimizationMode === 'off' ? { mode: 'off' } : {}),
    model,
    requestData,
    headers,
  };
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
  edge:    'Local',
  mid:     'OSS cloud',
  async:   'async GPU',
  premium: 'Premium',
};

function logSavings(entry) {
  const tierLabel = TIER_LABELS[entry.routeTier] || entry.routeTier || 'unknown';
  const fallback = entry.routeFallbackUsed ? ` (fallback from ${entry.preferredTier})` : '';
  const isLocal = entry.routeTier === 'edge';

  const lines = [];

  lines.push(`✓ Route: ${tierLabel}${fallback}`);
  lines.push(`✓ Context: ${entry.originalTokens.toLocaleString()} → ${entry.optimizedTokens.toLocaleString()} tokens`);

  const removed = entry.contextTokensRemoved ?? 0;
  if (removed > 0) {
    const pct = entry.originalTokens > 0 ? Math.round((removed / entry.originalTokens) * 100) : 0;
    lines.push(`✓ Safely removed: ${removed.toLocaleString()} tokens (${pct}%)`);
  }

  // Only report confirmed cache tokens — never estimate cache savings without upstream confirmation.
  if (typeof entry.cachedTokens === 'number' && entry.cachedTokens > 0) {
    lines.push(`✓ Confirmed cached input: ${entry.cachedTokens.toLocaleString()} tokens`);
  }

  lines.push(`✓ Actual cost: $${entry.actualCostUsd.toFixed(4)}`);

  if (!isLocal && entry.estimatedSavingsVsSonnet > 0) {
    lines.push(`✓ Estimated saved vs Claude Sonnet: $${entry.estimatedSavingsVsSonnet.toFixed(4)}`);
  }

  lines.push(`  (${entry.latencyMs}ms${entry.streaming ? ', stream' : ''})`);

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
  const estimatedCostVsHaiku = estimateHaikuCost(fields.originalTokens);
  const estimatedCostVsSonnet = estimateSonnetCost(fields.originalTokens);
  const estimatedSavingsVsHaiku = Math.max(estimatedCostVsHaiku - actualCostUsd, 0);
  const estimatedSavingsVsSonnet = Math.max(estimatedCostVsSonnet - actualCostUsd, 0);

  // Estimate cache-eligible tokens as the stable prefix: system messages + tool definitions.
  // This is an estimate — only confirmed upstream values are reported as confirmed_cached_tokens.
  const stableMessages = (fields.optimized.messages || []).filter((m) => m.role === 'system');
  const estimatedCacheEligibleTokens = countTokens(stableMessages, fields.model);
  const tierLabel = TIER_LABELS[fields.route.selectedTier] || fields.route.selectedTier;
  const actualRoute = `${tierLabel} — ${fields.model}`;

  return {
    model: fields.model,
    client: fields.clientHeaders?.['x-badgr-client'] || null,
    actualRoute,
    originalTokens: fields.originalTokens,
    optimizedTokens: fields.optimizedTokens,
    tokensSaved: fields.savings.savedTokens,
    savedPercent: fields.savings.savedPercent,
    estimatedSavingsUsd: fields.savings.savedCost,
    actualCostUsd,
    estimatedCostVsHaiku,
    estimatedCostVsSonnet,
    estimatedSavingsVsHaiku,
    estimatedSavingsVsSonnet,
    cachedTokens: fields.cachedTokens ?? 0,
    estimatedCacheEligibleTokens,
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
    providerRequestId: fields.providerRequestId ?? null,
    startedAt: fields.startedAtIso ?? null,
    endedAt: fields.endedAtIso ?? null,
    streamCompleted: fields.streamCompleted ?? false,
    clientDisconnected: fields.clientDisconnected ?? false,
    timedOut: fields.timedOut ?? false,
    outputTokensReceived: fields.outputTokensReceived ?? 0,
    providerUsageReported: fields.providerUsageReported ?? false,
    chargeStatus: fields.chargeStatus ?? null,
    contextUsedPercent: fields.contextHealth?.usedPercent ?? null,
    compactionRecommended: fields.contextHealth?.compactionRecommended ?? false,
    filesReadCount: fields.receiptFields?.filesReadCount ?? 0,
    relevantFilesCount: fields.receiptFields?.relevantFilesCount ?? 0,
    toolResultsPreserved: fields.receiptFields?.toolResultsPreserved ?? 0,
    optimizationRulesApplied: fields.receiptFields?.optimizationRulesApplied ?? [],
  };
}

function computeChargeStatus({ statusCode, clientDisconnected, timedOut, providerUsageReported }) {
  if ((statusCode || 200) >= 400) return 'not_charged';
  if (providerUsageReported) return 'confirmed_usage_reported';
  if (clientDisconnected || timedOut) return 'potentially_charged';
  return 'unknown';
}

const FILE_PATH_RE = /\b[\w\-./]+\.(?:js|ts|py|go|rs|java|tsx|jsx|json|yaml|yml|md|sh|css|html|rb|c|cpp|h)\b/i;

function computeReceiptFields(optimizedMessages, removedBlocks) {
  const toolResultsPreserved = (optimizedMessages || []).filter(
    m => m.role === 'tool' || m.tool_call_id
  ).length;

  const filesReadCount = (optimizedMessages || []).filter(
    m => (m.role === 'tool' || m.tool_call_id) &&
      FILE_PATH_RE.test(typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''))
  ).length;

  const optimizationRulesApplied = [...new Set(
    (removedBlocks || []).map(b => b.reason).filter(Boolean)
  )];

  return { toolResultsPreserved, filesReadCount, relevantFilesCount: filesReadCount, optimizationRulesApplied };
}

function _maybeStoreEvalPayload(savedLog, proxyConfig, requestData, optimized, model) {
  const rate = proxyConfig.evalSampleRate ?? 0;
  if (rate <= 0 || !savedLog?.id || Math.random() >= rate) return;
  saveEvalPayload({
    requestId: savedLog.id,
    originalMessages: requestData.messages || [],
    optimizedMessages: optimized.messages,
    removedBlocks: optimized.removedBlocks || [],
    model,
  }).catch(() => {});
}

// ── Anthropic Messages API helpers ──────────────────────────────────────────

function anthropicMessagesToOpenAI(messages = [], system) {
  const result = [];

  if (system) {
    const systemText = typeof system === 'string'
      ? system
      : (Array.isArray(system)
        ? system.filter(b => b.type === 'text').map(b => b.text || '').join('')
        : String(system));
    result.push({ role: 'system', content: systemText });
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      const content = msg.content;
      if (typeof content === 'string') {
        result.push({ role: 'user', content });
      } else if (Array.isArray(content)) {
        const toolResults = content.filter(b => b.type === 'tool_result');
        const textBlocks = content.filter(b => b.type === 'text');

        for (const tr of toolResults) {
          const toolContent = typeof tr.content === 'string'
            ? tr.content
            : (Array.isArray(tr.content)
              ? tr.content.filter(b => b.type === 'text').map(b => b.text || '').join('')
              : '');
          result.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: toolContent });
        }

        if (textBlocks.length > 0) {
          const text = textBlocks.map(b => b.text || '').join('');
          result.push({ role: 'user', content: text });
        }
      }
    } else if (msg.role === 'assistant') {
      const content = msg.content;
      if (typeof content === 'string') {
        result.push({ role: 'assistant', content });
      } else if (Array.isArray(content)) {
        const textBlocks = content.filter(b => b.type === 'text');
        const toolUseBlocks = content.filter(b => b.type === 'tool_use');
        const assistantMsg = { role: 'assistant' };
        if (textBlocks.length > 0) assistantMsg.content = textBlocks.map(b => b.text || '').join('');
        if (toolUseBlocks.length > 0) {
          assistantMsg.tool_calls = toolUseBlocks.map(b => ({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
          }));
        }
        result.push(assistantMsg);
      }
    }
  }

  return result;
}

function anthropicToOpenAIRequest(requestData) {
  const messages = anthropicMessagesToOpenAI(requestData.messages, requestData.system);
  const openAIReq = {
    model: requestData.model,
    messages,
    stream: requestData.stream || false,
  };

  if (requestData.max_tokens) openAIReq.max_tokens = requestData.max_tokens;
  if (requestData.temperature !== undefined) openAIReq.temperature = requestData.temperature;
  if (requestData.top_p !== undefined) openAIReq.top_p = requestData.top_p;
  if (requestData.stop_sequences) openAIReq.stop = requestData.stop_sequences;

  if (requestData.tools && requestData.tools.length > 0) {
    openAIReq.tools = requestData.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }));
    if (requestData.tool_choice) {
      const tc = requestData.tool_choice;
      if (tc.type === 'auto') openAIReq.tool_choice = 'auto';
      else if (tc.type === 'any') openAIReq.tool_choice = 'required';
      else if (tc.type === 'tool') openAIReq.tool_choice = { type: 'function', function: { name: tc.name } };
    }
  }

  return openAIReq;
}

const FINISH_REASON_TO_ANTHROPIC = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  length: 'max_tokens',
  content_filter: 'stop_sequence',
};

function openAIToAnthropicResponse(openAIData, originalModel, msgId) {
  const choice = openAIData?.choices?.[0];
  const message = choice?.message;
  const content = [];

  if (message?.content) content.push({ type: 'text', text: message.content });
  if (Array.isArray(message?.tool_calls)) {
    for (const tc of message.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments || '{}'); } catch { input = {}; }
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
    }
  }

  const usage = openAIData?.usage || {};
  return {
    id: msgId,
    type: 'message',
    role: 'assistant',
    model: originalModel,
    content,
    stop_reason: FINISH_REASON_TO_ANTHROPIC[choice?.finish_reason] || 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 },
  };
}

async function streamOpenAIToAnthropic(upstreamResponse, res, originalModel, msgId) {
  function sseWrite(event, data) {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  sseWrite('message_start', {
    type: 'message_start',
    message: {
      id: msgId, type: 'message', role: 'assistant', model: originalModel,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  sseWrite('ping', { type: 'ping' });

  let nextBlockIndex = 0;
  let textBlockIndex = -1;
  const toolBlockMap = {};
  let stopReason = 'end_turn';
  let outputTokens = 0;
  let inputTokens = 0;
  let sseBuffer = '';

  try {
    for await (const chunk of Readable.fromWeb(upstreamResponse.body)) {
      sseBuffer += chunk.toString('utf8');
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const rawData = line.slice(6).trim();
        if (rawData === '[DONE]') continue;
        let parsed;
        try { parsed = JSON.parse(rawData); } catch { continue; }

        const choice = parsed?.choices?.[0];
        const delta = choice?.delta;
        if (parsed?.usage) {
          inputTokens = parsed.usage.prompt_tokens || 0;
          outputTokens = parsed.usage.completion_tokens || 0;
        }
        if (choice?.finish_reason && choice.finish_reason !== 'null') {
          stopReason = FINISH_REASON_TO_ANTHROPIC[choice.finish_reason] || 'end_turn';
        }
        if (!delta) continue;

        if (typeof delta.content === 'string' && delta.content.length > 0) {
          if (textBlockIndex === -1) {
            textBlockIndex = nextBlockIndex++;
            sseWrite('content_block_start', {
              type: 'content_block_start', index: textBlockIndex,
              content_block: { type: 'text', text: '' },
            });
          }
          sseWrite('content_block_delta', {
            type: 'content_block_delta', index: textBlockIndex,
            delta: { type: 'text_delta', text: delta.content },
          });
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const tcIdx = typeof tc.index === 'number' ? tc.index : 0;
            if (!(tcIdx in toolBlockMap)) {
              const aIdx = nextBlockIndex++;
              toolBlockMap[tcIdx] = aIdx;
              sseWrite('content_block_start', {
                type: 'content_block_start', index: aIdx,
                content_block: { type: 'tool_use', id: tc.id || `toolu_${aIdx}`, name: tc.function?.name || '', input: {} },
              });
            }
            if (tc.function?.arguments) {
              sseWrite('content_block_delta', {
                type: 'content_block_delta', index: toolBlockMap[tcIdx],
                delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
              });
            }
          }
        }
      }
    }
  } catch (err) {
    process.stderr.write(`[badgr-token-proxy] /v1/messages stream error: ${err.message}\n`);
  }

  if (textBlockIndex !== -1) sseWrite('content_block_stop', { type: 'content_block_stop', index: textBlockIndex });
  for (const aIdx of Object.values(toolBlockMap)) sseWrite('content_block_stop', { type: 'content_block_stop', index: aIdx });
  sseWrite('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } });
  sseWrite('message_stop', { type: 'message_stop' });
  if (!res.writableEnded) res.end();

  return { stopReason, inputTokens, outputTokens };
}

// ── Legacy completions (FIM / text completions) helpers ─────────────────────

function legacyCompletionToChatRequest(requestData) {
  const prompt = requestData.prompt || '';
  const suffix = requestData.suffix || '';

  let userContent;
  if (suffix) {
    userContent = `Complete the code. Output only the inserted text, nothing else.\n<prefix>${prompt}</prefix>\n<suffix>${suffix}</suffix>`;
  } else {
    userContent = `Continue the following text. Output only the continuation, nothing else:\n${prompt}`;
  }

  const chatReq = {
    model: requestData.model,
    messages: [{ role: 'user', content: userContent }],
    stream: requestData.stream || false,
  };
  if (requestData.max_tokens) chatReq.max_tokens = requestData.max_tokens;
  if (requestData.temperature !== undefined) chatReq.temperature = requestData.temperature;
  if (requestData.top_p !== undefined) chatReq.top_p = requestData.top_p;
  if (requestData.stop) chatReq.stop = requestData.stop;
  return chatReq;
}

function chatResponseToLegacyCompletion(openAIData, completionId, originalModel) {
  const choice = openAIData?.choices?.[0];
  const text = choice?.message?.content || '';
  const usage = openAIData?.usage || {};
  return {
    id: completionId,
    object: 'text_completion',
    created: Math.floor(Date.now() / 1000),
    model: originalModel || openAIData?.model || '',
    choices: [{ text, index: 0, logprobs: null, finish_reason: choice?.finish_reason || 'stop' }],
    usage: {
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0,
    },
  };
}

async function streamChatToLegacyCompletion(upstreamResponse, res, completionId, originalModel) {
  let sseBuffer = '';
  let outputTokens = 0;
  let inputTokens = 0;

  try {
    for await (const chunk of Readable.fromWeb(upstreamResponse.body)) {
      sseBuffer += chunk.toString('utf8');
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const rawData = line.slice(6).trim();

        if (rawData === '[DONE]') {
          if (!res.writableEnded) res.write('data: [DONE]\n\n');
          continue;
        }

        let parsed;
        try { parsed = JSON.parse(rawData); } catch { continue; }

        const choice = parsed?.choices?.[0];
        const text = choice?.delta?.content || '';
        if (parsed?.usage) {
          inputTokens = parsed.usage.prompt_tokens || 0;
          outputTokens = parsed.usage.completion_tokens || 0;
        }

        const legacyChunk = {
          id: completionId,
          object: 'text_completion',
          created: Math.floor(Date.now() / 1000),
          model: originalModel,
          choices: [{ text, index: 0, logprobs: null, finish_reason: choice?.finish_reason || null }],
        };
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(legacyChunk)}\n\n`);
      }
    }
  } catch (err) {
    process.stderr.write(`[badgr-token-proxy] /v1/completions stream error: ${err.message}\n`);
  }

  if (!res.writableEnded) res.end();
  return { inputTokens, outputTokens };
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  const method = req.method || 'GET';

  // ── Health ──────────────────────────────────────────────────────────────────
  if (method === 'GET' && url === '/health') {
    const boundPort = server.address()?.port ?? PROXY_PORT;
    jsonResponse(res, 200, { status: 'ok', proxy: 'badgr-token-proxy', base_url: `http://localhost:${boundPort}/v1` });
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

    // ── Routing ───────────────────────────────────────────────────────────────
    let route;
    if (proxyConfig.routingMode === 'direct') {
      const directModel = (requestData.model && requestData.model !== 'badgr-auto')
        ? requestData.model
        : (proxyConfig.defaultModel || 'deepseek-chat');
      route = {
        preferredTier: 'mid', selectedTier: 'mid',
        model: directModel,
        baseUrl: proxyConfig.upstreamBaseUrl || proxyConfig.midBaseUrl,
        reason: 'routing disabled — direct passthrough',
        taskType: null, classification: null, promptTokens: 0,
        latencyTargetMs: null, fallbackUsed: false,
      };
    } else {
      route = routeRequest(requestData, proxyConfig);
    }

    const model = route.model || requestData.model || 'gpt-4o-mini';
    const startedAt = Date.now();

    const badgrClientHeaders = {
      'x-badgr-client': req.headers['x-badgr-client'] || '',
      'x-badgr-task-type': req.headers['x-badgr-task-type'] || '',
      'x-badgr-mode': req.headers['x-badgr-mode'] || '',
    };

    // ── Token optimization (routing above is unaffected) ─────────────────────
    const originalTokens = countTokens(requestData.messages || [], model);
    const optimized = optimizeMessages(
      requestData.messages || [],
      buildOptimizerOptions(proxyConfig, requestData, badgrClientHeaders, model),
    );
    const optimizedRequest = { ...requestData, model, messages: optimized.messages };
    const optimizedTokens = countTokens(optimizedRequest.messages || [], model);
    const savings = estimateSavings(originalTokens, optimizedTokens, model);

    // ── Streaming path ────────────────────────────────────────────────────────
    if (requestData.stream) {
      const abort = new AbortController();
      let clientDisconnected = false;
      req.on('close', () => { clientDisconnected = true; abort.abort(); });

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

      const providerRequestId = upstreamResponse.headers.get('x-request-id') || upstreamResponse.headers.get('cf-ray') || null;
      const startedAtIso = new Date(startedAt).toISOString();
      let firstChunkAt = 0;
      let streamCompleted = false;
      let outputTokensReceived = 0;
      let providerUsageReported = false;
      let sseBuffer = '';

      try {
        // Readable.fromWeb gives us reliable async iteration on Node 18+
        for await (const chunk of Readable.fromWeb(upstreamResponse.body)) {
          if (!firstChunkAt) firstChunkAt = Date.now();
          if (!res.writableEnded) res.write(chunk);

          // Parse SSE lines to detect [DONE] and usage metadata
          sseBuffer += chunk.toString('utf8');
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') { streamCompleted = true; continue; }
            try {
              const parsed = JSON.parse(data);
              const usage = parsed?.usage;
              if (usage && typeof usage === 'object') {
                providerUsageReported = true;
                const completionTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
                if (completionTokens > 0) outputTokensReceived = completionTokens;
              }
            } catch { /* non-JSON SSE line */ }
          }
        }
      } catch (err) {
        // Upstream or client disconnected mid-stream — not fatal
        if (!abort.signal.aborted) {
          process.stderr.write(`[badgr-token-proxy] Stream interrupted: ${err.message}\n`);
        }
      } finally {
        if (!res.writableEnded) res.end();
      }

      const endedAtIso = new Date().toISOString();
      const chargeStatus = computeChargeStatus({ statusCode: upstreamResponse.status, clientDisconnected, timedOut: false, providerUsageReported });
      const latencyMs = firstChunkAt ? firstChunkAt - startedAt : Date.now() - startedAt;
      const contextHealth = computeContextHealth(optimizedTokens, model);
      const receiptFields = computeReceiptFields(optimized.messages, optimized.removedBlocks);
      const entry = buildLogEntry({ model, originalTokens, optimizedTokens, savings, route, optimized, cachedTokens: 0, latencyMs, statusCode: upstreamResponse.status, streaming: true, clientHeaders: badgrClientHeaders, providerRequestId, startedAtIso, endedAtIso, streamCompleted, clientDisconnected, timedOut: false, outputTokensReceived, providerUsageReported, chargeStatus, contextHealth, receiptFields });
      logSavings(entry);
      const savedLog = await saveRequestLog(entry);
      _maybeStoreEvalPayload(savedLog, proxyConfig, requestData, optimized, model);
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
    const bufferedProviderRequestId = upstreamData?.id || null;
    const bufferedStartedAtIso = new Date(startedAt).toISOString();
    const bufferedEndedAtIso = new Date().toISOString();
    const bufferedOutputTokens = upstreamData?.usage?.completion_tokens ?? upstreamData?.usage?.output_tokens ?? 0;
    const bufferedUsageReported = !!(upstreamData?.usage);
    const bufferedChargeStatus = computeChargeStatus({ statusCode, clientDisconnected: false, timedOut: false, providerUsageReported: bufferedUsageReported });
    const bufferedContextHealth = computeContextHealth(optimizedTokens, model);
    const bufferedReceiptFields = computeReceiptFields(optimized.messages, optimized.removedBlocks);
    const entry = buildLogEntry({ model, originalTokens, optimizedTokens, savings, route, optimized, cachedTokens, latencyMs, statusCode, streaming: false, clientHeaders: badgrClientHeaders, providerRequestId: bufferedProviderRequestId, startedAtIso: bufferedStartedAtIso, endedAtIso: bufferedEndedAtIso, streamCompleted: statusCode < 400, clientDisconnected: false, timedOut: false, outputTokensReceived: bufferedOutputTokens, providerUsageReported: bufferedUsageReported, chargeStatus: bufferedChargeStatus, contextHealth: bufferedContextHealth, receiptFields: bufferedReceiptFields });
    logSavings(entry);
    const savedLog = await saveRequestLog(entry);
    _maybeStoreEvalPayload(savedLog, proxyConfig, requestData, optimized, model);
    pushSavingsToBackend(entry);
    trackRequest(entry);
    if (statusCode >= 500) {
      trackError({ routeTier: route.selectedTier, model, statusCode, errorType: 'upstream_error', streaming: false, latencyMs });
    }
    const bufferedBadgrHdrs = buildBadgrHeaders(originalTokens, optimizedTokens, savings, route, cachedTokens);
    jsonResponse(res, statusCode, upstreamData, bufferedBadgrHdrs);
    return;
  }

  // ── Legacy text completions (FIM / autocomplete for Continue, Tabby, etc.) ─
  if (method === 'POST' && url === '/v1/completions') {
    let requestData;
    try {
      requestData = JSON.parse(await readBody(req));
    } catch {
      jsonResponse(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } });
      return;
    }

    const proxyConfig = loadProxyConfig();
    const openAIRequest = legacyCompletionToChatRequest(requestData);

    let route;
    if (proxyConfig.routingMode === 'direct') {
      const directModel = (openAIRequest.model && openAIRequest.model !== 'badgr-auto')
        ? openAIRequest.model
        : (proxyConfig.defaultModel || 'deepseek-chat');
      route = {
        preferredTier: 'edge', selectedTier: 'edge',
        model: directModel,
        baseUrl: proxyConfig.upstreamBaseUrl || proxyConfig.midBaseUrl,
        reason: 'routing disabled — direct passthrough',
        taskType: null, classification: null, promptTokens: 0,
        latencyTargetMs: null, fallbackUsed: false,
      };
    } else {
      route = routeRequest(openAIRequest, proxyConfig);
    }

    const model = route.model || openAIRequest.model || 'gpt-4o-mini';
    const originalModel = requestData.model || model;
    const startedAt = Date.now();
    const completionId = `cmpl_${Date.now().toString(36)}`;

    const badgrClientHeaders = {
      'x-badgr-client': req.headers['x-badgr-client'] || '',
      'x-badgr-task-type': req.headers['x-badgr-task-type'] || 'autocomplete',
      'x-badgr-mode': req.headers['x-badgr-mode'] || '',
    };

    const originalTokens = countTokens(openAIRequest.messages || [], model);
    const optimized = optimizeMessages(
      openAIRequest.messages || [],
      buildOptimizerOptions(proxyConfig, openAIRequest, badgrClientHeaders, model),
    );
    const optimizedRequest = { ...openAIRequest, model, messages: optimized.messages };
    const optimizedTokens = countTokens(optimizedRequest.messages || [], model);
    const savings = estimateSavings(originalTokens, optimizedTokens, model);

    if (requestData.stream) {
      const abort = new AbortController();
      let clientDisconnected = false;
      req.on('close', () => { clientDisconnected = true; abort.abort(); });

      let upstreamResponse;
      try {
        upstreamResponse = await forwardStream('/chat/completions', optimizedRequest, req.headers, route.baseUrl, abort.signal);
      } catch (err) {
        const msg = abort.signal.aborted ? 'Client disconnected' : err.message;
        jsonResponse(res, 502, { error: { message: msg, type: 'proxy_error' } });
        return;
      }

      if (!upstreamResponse.ok) {
        const errText = await upstreamResponse.text().catch(() => '');
        let errData;
        try { errData = errText ? JSON.parse(errText) : {}; } catch { errData = { error: { message: errText } }; }
        jsonResponse(res, upstreamResponse.status, errData);
        return;
      }

      const streamBadgrHdrs = buildBadgrHeaders(originalTokens, optimizedTokens, savings, route, 0);
      res.writeHead(upstreamResponse.status, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...streamBadgrHdrs,
      });

      const startedAtIso = new Date(startedAt).toISOString();
      const { outputTokens: ot } = await streamChatToLegacyCompletion(upstreamResponse, res, completionId, originalModel);

      const endedAtIso = new Date().toISOString();
      const latencyMs = Date.now() - startedAt;
      const contextHealth = computeContextHealth(optimizedTokens, model);
      const receiptFields = computeReceiptFields(optimized.messages, optimized.removedBlocks);
      const entry = buildLogEntry({
        model, originalTokens, optimizedTokens, savings, route, optimized, cachedTokens: 0,
        latencyMs, statusCode: upstreamResponse.status, streaming: true,
        clientHeaders: badgrClientHeaders, providerRequestId: null, startedAtIso, endedAtIso,
        streamCompleted: true, clientDisconnected, timedOut: false,
        outputTokensReceived: ot, providerUsageReported: ot > 0,
        chargeStatus: computeChargeStatus({ statusCode: upstreamResponse.status, clientDisconnected, timedOut: false, providerUsageReported: ot > 0 }),
        contextHealth, receiptFields,
      });
      logSavings(entry);
      const savedLog = await saveRequestLog(entry);
      _maybeStoreEvalPayload(savedLog, proxyConfig, openAIRequest, optimized, model);
      pushSavingsToBackend(entry);
      trackRequest(entry);
      return;
    }

    // Buffered path
    let statusCode = 502;
    let upstreamData;
    try {
      const upstream = await forwardJson('/chat/completions', optimizedRequest, req.headers, route.baseUrl);
      statusCode = upstream.status;
      upstreamData = upstream.data;
    } catch (err) {
      upstreamData = { error: { message: err.message, type: 'proxy_error' } };
    }

    if (statusCode >= 400) {
      jsonResponse(res, statusCode, upstreamData);
      return;
    }

    const completionResp = chatResponseToLegacyCompletion(upstreamData, completionId, originalModel);
    const cachedTokensComp = extractCachedTokens(upstreamData);
    const latencyMsComp = Date.now() - startedAt;
    const bufferedOutputTokens = upstreamData?.usage?.completion_tokens ?? 0;
    const bufferedUsageReported = !!(upstreamData?.usage);
    const bufferedContextHealth = computeContextHealth(optimizedTokens, model);
    const bufferedReceiptFields = computeReceiptFields(optimized.messages, optimized.removedBlocks);
    const compEntry = buildLogEntry({
      model, originalTokens, optimizedTokens, savings, route, optimized,
      cachedTokens: cachedTokensComp, latencyMs: latencyMsComp, statusCode, streaming: false,
      clientHeaders: badgrClientHeaders, providerRequestId: upstreamData?.id || null,
      startedAtIso: new Date(startedAt).toISOString(), endedAtIso: new Date().toISOString(),
      streamCompleted: true, clientDisconnected: false, timedOut: false,
      outputTokensReceived: bufferedOutputTokens, providerUsageReported: bufferedUsageReported,
      chargeStatus: computeChargeStatus({ statusCode, clientDisconnected: false, timedOut: false, providerUsageReported: bufferedUsageReported }),
      contextHealth: bufferedContextHealth, receiptFields: bufferedReceiptFields,
    });
    logSavings(compEntry);
    const savedCompLog = await saveRequestLog(compEntry);
    _maybeStoreEvalPayload(savedCompLog, proxyConfig, openAIRequest, optimized, model);
    pushSavingsToBackend(compEntry);
    trackRequest(compEntry);
    const compBadgrHdrs = buildBadgrHeaders(originalTokens, optimizedTokens, savings, route, cachedTokensComp);
    jsonResponse(res, 200, completionResp, compBadgrHdrs);
    return;
  }

  // ── Anthropic Messages API ────────────────────────────────────────────────
  if (method === 'POST' && url === '/v1/messages') {
    let requestData;
    try {
      requestData = JSON.parse(await readBody(req));
    } catch {
      jsonResponse(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON body' } });
      return;
    }

    const proxyConfig = loadProxyConfig();
    const openAIRequest = anthropicToOpenAIRequest(requestData);

    let route;
    if (proxyConfig.routingMode === 'direct') {
      const directModel = (openAIRequest.model && openAIRequest.model !== 'badgr-auto')
        ? openAIRequest.model
        : (proxyConfig.defaultModel || 'deepseek-chat');
      route = {
        preferredTier: 'mid', selectedTier: 'mid',
        model: directModel,
        baseUrl: proxyConfig.upstreamBaseUrl || proxyConfig.midBaseUrl,
        reason: 'routing disabled — direct passthrough',
        taskType: null, classification: null, promptTokens: 0,
        latencyTargetMs: null, fallbackUsed: false,
      };
    } else {
      route = routeRequest(openAIRequest, proxyConfig);
    }

    const model = route.model || openAIRequest.model || 'gpt-4o-mini';
    const originalModel = requestData.model;
    const startedAt = Date.now();
    const msgId = `msg_${Date.now().toString(36)}`;

    const badgrClientHeaders = {
      'x-badgr-client': req.headers['x-badgr-client'] || '',
      'x-badgr-task-type': req.headers['x-badgr-task-type'] || '',
      'x-badgr-mode': req.headers['x-badgr-mode'] || '',
    };

    const originalTokens = countTokens(openAIRequest.messages || [], model);
    const optimized = optimizeMessages(
      openAIRequest.messages || [],
      buildOptimizerOptions(proxyConfig, openAIRequest, badgrClientHeaders, model),
    );
    const optimizedRequest = { ...openAIRequest, model, messages: optimized.messages };
    const optimizedTokens = countTokens(optimizedRequest.messages || [], model);
    const savings = estimateSavings(originalTokens, optimizedTokens, model);

    if (requestData.stream) {
      const abort = new AbortController();
      let clientDisconnected = false;
      req.on('close', () => { clientDisconnected = true; abort.abort(); });

      let upstreamResponse;
      try {
        upstreamResponse = await forwardStream('/chat/completions', optimizedRequest, req.headers, route.baseUrl, abort.signal);
      } catch (err) {
        const msg = abort.signal.aborted ? 'Client disconnected before upstream responded' : err.message;
        jsonResponse(res, 529, { type: 'error', error: { type: 'overloaded_error', message: msg } });
        return;
      }

      if (!upstreamResponse.ok) {
        const errText = await upstreamResponse.text().catch(() => '');
        let errData;
        try { errData = errText ? JSON.parse(errText) : {}; } catch { errData = { type: 'error', error: { type: 'api_error', message: errText } }; }
        jsonResponse(res, upstreamResponse.status, errData);
        return;
      }

      if (!upstreamResponse.body) {
        jsonResponse(res, 529, { type: 'error', error: { type: 'overloaded_error', message: 'Upstream returned no body' } });
        return;
      }

      const streamBadgrHdrs = buildBadgrHeaders(originalTokens, optimizedTokens, savings, route, 0);
      res.writeHead(upstreamResponse.status, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...streamBadgrHdrs,
      });

      const providerRequestId = upstreamResponse.headers.get('x-request-id') || null;
      const startedAtIso = new Date(startedAt).toISOString();
      const { stopReason: sr, outputTokens: ot } = await streamOpenAIToAnthropic(upstreamResponse, res, originalModel, msgId);

      const endedAtIso = new Date().toISOString();
      const latencyMs = Date.now() - startedAt;
      const contextHealth = computeContextHealth(optimizedTokens, model);
      const receiptFields = computeReceiptFields(optimized.messages, optimized.removedBlocks);
      const streamEntry = buildLogEntry({
        model, originalTokens, optimizedTokens, savings, route, optimized, cachedTokens: 0,
        latencyMs, statusCode: upstreamResponse.status, streaming: true,
        clientHeaders: badgrClientHeaders, providerRequestId, startedAtIso, endedAtIso,
        streamCompleted: true, clientDisconnected, timedOut: false,
        outputTokensReceived: ot, providerUsageReported: ot > 0,
        chargeStatus: computeChargeStatus({ statusCode: upstreamResponse.status, clientDisconnected, timedOut: false, providerUsageReported: ot > 0 }),
        contextHealth, receiptFields,
      });
      logSavings(streamEntry);
      const savedStreamLog = await saveRequestLog(streamEntry);
      _maybeStoreEvalPayload(savedStreamLog, proxyConfig, openAIRequest, optimized, model);
      pushSavingsToBackend(streamEntry);
      trackRequest(streamEntry);
      return;
    }

    // Buffered path
    let statusCode = 502;
    let upstreamData;
    try {
      const upstream = await forwardJson('/chat/completions', optimizedRequest, req.headers, route.baseUrl);
      statusCode = upstream.status;
      upstreamData = upstream.data;
    } catch (err) {
      upstreamData = { error: { message: err.message, type: 'proxy_error' } };
    }

    if (statusCode >= 400) {
      jsonResponse(res, statusCode, upstreamData);
      return;
    }

    const cachedTokensMsgs = extractCachedTokens(upstreamData);
    const latencyMsMsgs = Date.now() - startedAt;
    const anthropicResp = openAIToAnthropicResponse(upstreamData, originalModel, msgId);
    const bufferedUsageReported = !!(upstreamData?.usage);
    const bufferedOutputTokens = upstreamData?.usage?.completion_tokens ?? 0;
    const bufferedContextHealth = computeContextHealth(optimizedTokens, model);
    const bufferedReceiptFields = computeReceiptFields(optimized.messages, optimized.removedBlocks);
    const msgEntry = buildLogEntry({
      model, originalTokens, optimizedTokens, savings, route, optimized,
      cachedTokens: cachedTokensMsgs, latencyMs: latencyMsMsgs, statusCode, streaming: false,
      clientHeaders: badgrClientHeaders, providerRequestId: upstreamData?.id || null,
      startedAtIso: new Date(startedAt).toISOString(), endedAtIso: new Date().toISOString(),
      streamCompleted: true, clientDisconnected: false, timedOut: false,
      outputTokensReceived: bufferedOutputTokens, providerUsageReported: bufferedUsageReported,
      chargeStatus: computeChargeStatus({ statusCode, clientDisconnected: false, timedOut: false, providerUsageReported: bufferedUsageReported }),
      contextHealth: bufferedContextHealth, receiptFields: bufferedReceiptFields,
    });
    logSavings(msgEntry);
    const savedMsgLog = await saveRequestLog(msgEntry);
    _maybeStoreEvalPayload(savedMsgLog, proxyConfig, openAIRequest, optimized, model);
    pushSavingsToBackend(msgEntry);
    trackRequest(msgEntry);
    const badgrHdrsMsgs = buildBadgrHeaders(originalTokens, optimizedTokens, savings, route, cachedTokensMsgs);
    jsonResponse(res, 200, anthropicResp, badgrHdrsMsgs);
    return;
  }

  // ── Generic passthrough for unrecognised /v1/* paths ─────────────────────
  // Handles embeddings, audio, images, and any other OpenAI-compatible routes
  // that tools may call (Continue, LangChain, LlamaIndex, etc.).
  if ((method === 'GET' || method === 'POST' || method === 'DELETE') && url.startsWith('/v1/')) {
    try {
      const proxyConfig = loadProxyConfig();
      const base = getUpstreamBaseUrl(proxyConfig, undefined);
      const path = url.slice(3); // strip leading /v1 → /models, /embeddings, etc.
      const isGetOrDelete = method === 'GET' || method === 'DELETE';
      let bodyBuf;
      if (!isGetOrDelete) {
        const raw = await readBody(req);
        bodyBuf = raw;
      }
      const upstreamUrl = `${base}${path}`;
      const fetchOpts = {
        method,
        headers: {
          accept: 'application/json',
          ...upstreamHeaders(req.headers, base),
          ...(bodyBuf ? { 'content-type': req.headers['content-type'] || 'application/json' } : {}),
        },
        body: bodyBuf || undefined,
      };
      const upstream = await fetch(upstreamUrl, fetchOpts);
      const text = await upstream.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
      jsonResponse(res, upstream.status, data);
    } catch (err) {
      jsonResponse(res, 502, { error: { message: err.message, type: 'proxy_error' } });
    }
    return;
  }

  jsonResponse(res, 404, { error: { message: 'Not found', type: 'not_found' } });
});

export { server };

// Auto-start when run directly (node proxy-server.js / badgr-auto start).
import { fileURLToPath } from 'node:url';
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  let portIdx = 0;

  const tryNextPort = () => {
    if (portIdx >= PROXY_PORTS.length) {
      process.stderr.write(
        `[badgr-token-proxy] All ports in use (tried: ${PROXY_PORTS.join(', ')}). ` +
        `Set BADGR_AUTO_PORT to use a different port.\n`,
      );
      process.exit(1);
    }
    server.listen(PROXY_PORTS[portIdx], '127.0.0.1');
  };

  server.on('listening', () => {
    const port = server.address().port;
    writeProxyPort(port);
    process.stderr.write(`[badgr-token-proxy] Listening on http://localhost:${port}/v1\n`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(
        `[badgr-token-proxy] Port ${PROXY_PORTS[portIdx]} in use, trying ${PROXY_PORTS[portIdx + 1] ?? 'none'}...\n`,
      );
      portIdx++;
      tryNextPort();
    } else {
      process.stderr.write(`[badgr-token-proxy] Server error: ${err.message}\n`);
      process.exit(1);
    }
  });

  tryNextPort();
}
