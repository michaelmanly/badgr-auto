import { classifyRequest, estimatePromptTokens } from './classify.js';

export const ROUTE_TIERS = {
  EDGE: 'edge',
  MID: 'mid',
  ASYNC: 'async',
  PREMIUM: 'premium',
};

const SIMPLE_TASKS = new Set(['autocomplete', 'formatting', 'format', 'small_edit', 'small-edits', 'small edit']);
const MID_TASKS = new Set(['refactor', 'summary', 'summarize', 'rag', 'query', 'normal', 'chat']);
const ASYNC_TASKS = new Set(['embedding', 'embeddings', 'indexing', 'index', 'batch', 'eval', 'evals', 'ingestion', 'tagging']);
const PREMIUM_TASKS = new Set(['deep_debugging', 'deep-debugging', 'deep debugging', 'reasoning', 'final_output', 'final-output', 'final response', 'critical']);

export const DEFAULT_ROUTING_OPTIONS = {
  edgeMaxTokens: 768,
  premiumMinTokens: 4096,
  edgeLatencyMs: 250,
  midLatencyMs: 2000,
  asyncLatencyMs: 30000,
  premiumLatencyMs: 6000,
};

function normalizeTaskType(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().replace(/\s+/g, '_');
}

function latestText(requestData = {}) {
  const messages = Array.isArray(requestData.messages) ? requestData.messages : [];
  return messages
    .map((message) => (typeof message?.content === 'string' ? message.content : ''))
    .join(' ')
    .toLowerCase();
}

function inferTaskType(requestData = {}) {
  const explicit = normalizeTaskType(
    requestData.badgr_task_type ||
    requestData.task_type ||
    requestData.metadata?.task_type ||
    requestData.metadata?.badgr_task_type
  );
  if (explicit) return explicit;

  const text = latestText(requestData);
  if (/\b(auto-?complete|completion|suggest next|inline suggestion)\b/.test(text)) return 'autocomplete';
  if (/\b(format|prettier|lint fix|small edit|rename variable)\b/.test(text)) return 'formatting';
  if (/\b(embed|embedding|index|ingest|tagging|batch|evals?)\b/.test(text)) return 'batch';
  if (/\b(deep debug|root cause|critical|final answer|final response|reasoning|prove|complex)\b/.test(text)) return 'reasoning';
  if (/\b(refactor|summari[sz]e|rag|search context|normal query)\b/.test(text)) return 'refactor';
  return '';
}

function tierEndpoint(config, tier) {
  const baseKey = `${tier}BaseUrl`;
  const modelKey = `${tier}Model`;
  return {
    baseUrl: config[baseKey] || (tier === ROUTE_TIERS.MID ? config.upstreamBaseUrl : ''),
    model: config[modelKey] || (tier === ROUTE_TIERS.MID ? config.midModel || config.defaultModel : config[modelKey]),
  };
}

function firstAvailableTier(preferredTier, config) {
  const orderByTier = {
    [ROUTE_TIERS.EDGE]: [ROUTE_TIERS.EDGE, ROUTE_TIERS.MID, ROUTE_TIERS.PREMIUM],
    [ROUTE_TIERS.MID]: [ROUTE_TIERS.MID, ROUTE_TIERS.EDGE, ROUTE_TIERS.PREMIUM],
    [ROUTE_TIERS.ASYNC]: [ROUTE_TIERS.ASYNC, ROUTE_TIERS.MID, ROUTE_TIERS.PREMIUM],
    [ROUTE_TIERS.PREMIUM]: [ROUTE_TIERS.PREMIUM, ROUTE_TIERS.MID],
  }[preferredTier] || [ROUTE_TIERS.MID, ROUTE_TIERS.PREMIUM];

  return orderByTier.find((tier) => Boolean(tierEndpoint(config, tier).baseUrl)) || ROUTE_TIERS.MID;
}

function selectPreferredTier(requestData, config) {
  const taskType = inferTaskType(requestData);
  const promptTokens = estimatePromptTokens(requestData.messages || []);
  const classification = classifyRequest(requestData, {
    mode: config.mode || 'balanced',
    simpleMaxTokens: config.edgeMaxTokens ?? DEFAULT_ROUTING_OPTIONS.edgeMaxTokens,
    hardMinTokens: config.premiumMinTokens ?? DEFAULT_ROUTING_OPTIONS.premiumMinTokens,
  });

  if (SIMPLE_TASKS.has(taskType)) return { tier: ROUTE_TIERS.EDGE, taskType, promptTokens, classification, reason: 'simple low-latency IDE task' };
  if (ASYNC_TASKS.has(taskType)) return { tier: ROUTE_TIERS.ASYNC, taskType, promptTokens, classification, reason: 'non-critical background workload' };
  if (PREMIUM_TASKS.has(taskType)) return { tier: ROUTE_TIERS.PREMIUM, taskType, promptTokens, classification, reason: 'complex or critical task' };
  if (MID_TASKS.has(taskType)) return { tier: ROUTE_TIERS.MID, taskType, promptTokens, classification, reason: 'normal/default workload' };

  if (classification === 'simple') return { tier: ROUTE_TIERS.EDGE, taskType, promptTokens, classification, reason: 'simple prompt under edge threshold' };
  if (classification === 'hard') return { tier: ROUTE_TIERS.PREMIUM, taskType, promptTokens, classification, reason: 'complex prompt requires premium quality' };
  return { tier: ROUTE_TIERS.MID, taskType, promptTokens, classification, reason: 'default cheapest tier meeting quality and latency' };
}

export function routeRequest(requestData = {}, config = {}) {
  const routingConfig = { ...DEFAULT_ROUTING_OPTIONS, ...config };
  const preferred = selectPreferredTier(requestData, routingConfig);
  const selectedTier = firstAvailableTier(preferred.tier, routingConfig);
  const endpoint = tierEndpoint(routingConfig, selectedTier);
  const requestedModel = requestData.model && requestData.model !== 'badgr-auto' ? requestData.model : '';
  const model = requestedModel || endpoint.model || routingConfig.defaultModel || 'gpt-4o-mini';
  const latencyTargetMs = routingConfig[`${selectedTier}LatencyMs`];
  const fallbackUsed = selectedTier !== preferred.tier;

  return {
    preferredTier: preferred.tier,
    selectedTier,
    model,
    baseUrl: endpoint.baseUrl || routingConfig.upstreamBaseUrl,
    reason: fallbackUsed
      ? `${preferred.reason}; ${preferred.tier} unavailable, using ${selectedTier}`
      : preferred.reason,
    taskType: preferred.taskType || null,
    classification: preferred.classification,
    promptTokens: preferred.promptTokens,
    latencyTargetMs,
    fallbackUsed,
  };
}
