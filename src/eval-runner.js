import { readEvalPayload, saveEvalResult } from './db.js';
import { loadConfig } from './config.js';
import { loadProxyConfig } from './proxy-config.js';

async function callModel(messages, { baseUrl, model, apiKey, timeoutMs = 30000 }) {
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ model, messages, stream: false, max_tokens: 2048 }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const latencyMs = Date.now() - startedAt;
  let data;
  try { data = await response.json(); } catch { data = {}; }
  return { data, statusCode: response.status, latencyMs };
}

export function sameToolCalls(a, b) {
  const getToolCalls = (response) =>
    (response?.data?.choices ?? []).flatMap(c => c.message?.tool_calls ?? []);
  const aCalls = getToolCalls(a);
  const bCalls = getToolCalls(b);
  if (aCalls.length !== bCalls.length) return false;
  for (let i = 0; i < aCalls.length; i++) {
    if (aCalls[i].function?.name !== bCalls[i].function?.name) return false;
    if (aCalls[i].function?.arguments !== bCalls[i].function?.arguments) return false;
  }
  return true;
}

export function noMissingContextComplaint(text) {
  if (!text) return true;
  return !/\b(missing context|don'?t have (the|that|this) (context|information|file|code)|cannot (find|locate|access)|not provided|not (found|available)|please (provide|share|give me)|unclear (what|which)|context (was|is) (removed|missing|unavailable)|I (don'?t|do not) have access)\b/i.test(text);
}

export function similarEnough(textA, textB, threshold = 0.5) {
  if (!textA && !textB) return true;
  if (!textA || !textB) return false;
  const ratio = Math.min(textA.length, textB.length) / Math.max(textA.length, textB.length);
  return ratio >= threshold;
}

function extractText(response) {
  return (response?.data?.choices ?? []).map(c => c.message?.content ?? '').join('');
}

function extractFinishReason(response) {
  return response?.data?.choices?.[0]?.finish_reason ?? null;
}

function extractUsage(response) {
  return response?.data?.usage ?? {};
}

export async function runEval(requestId) {
  const payload = await readEvalPayload(requestId);
  if (!payload) return { error: `No eval payload found for request ${requestId}` };

  const config = loadConfig();
  const proxyConfig = loadProxyConfig();
  const baseUrl = (proxyConfig.upstreamBaseUrl || proxyConfig.midBaseUrl || config.baseUrl || '').replace(/\/+$/, '');
  const apiKey = config.apiKey || process.env.BADGR_API_KEY || '';
  const model = payload.model || proxyConfig.midModel || 'deepseek-chat';

  if (!baseUrl) return { error: 'No upstream base URL configured. Run badgr-auto setup first.' };

  const callOpts = { baseUrl, model, apiKey };

  let originalResponse, optimizedResponse;
  try {
    [originalResponse, optimizedResponse] = await Promise.all([
      callModel(payload.original_messages, callOpts),
      callModel(payload.optimized_messages, callOpts),
    ]);
  } catch (err) {
    return { error: `Eval replay failed: ${err.message}` };
  }

  const originalText  = extractText(originalResponse);
  const optimizedText = extractText(optimizedResponse);
  const toolCallsMatch          = sameToolCalls(originalResponse, optimizedResponse);
  const finishReasonMatch       = extractFinishReason(originalResponse) === extractFinishReason(optimizedResponse);
  const missingContextComplaint = !noMissingContextComplaint(optimizedText);
  const outputLengthDelta       = optimizedText.length - originalText.length;
  const textSimilar             = similarEnough(originalText, optimizedText);

  const safe = toolCallsMatch && !missingContextComplaint && textSimilar;

  const result = {
    requestId,
    safe,
    originalOutput:  { text: originalText,  finishReason: extractFinishReason(originalResponse),  statusCode: originalResponse.statusCode },
    optimizedOutput: { text: optimizedText, finishReason: extractFinishReason(optimizedResponse), statusCode: optimizedResponse.statusCode },
    outputLengthDelta,
    toolCallsMatch,
    finishReasonMatch,
    missingContextComplaint,
    latencyOriginalMs:  originalResponse.latencyMs,
    latencyOptimizedMs: optimizedResponse.latencyMs,
    tokenUsageOriginal:  extractUsage(originalResponse),
    tokenUsageOptimized: extractUsage(optimizedResponse),
  };

  await saveEvalResult(result);
  return result;
}
