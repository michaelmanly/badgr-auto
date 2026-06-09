/**
 * PostHog analytics for badgr-auto.
 * Sends aggregated, non-identifying events — never prompt content.
 * All calls are fire-and-forget and never block a response.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.js';

const POSTHOG_HOST = process.env.POSTHOG_HOST || process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com';
const POSTHOG_KEY  = process.env.POSTHOG_API_KEY || process.env.NEXT_PUBLIC_POSTHOG_KEY || 'phc_ikoQL8xnooFmHivijgwygh8CXlvZibFeDztqpZ6bqCe';

const DEVICE_ID_FILE = join(CONFIG_DIR, 'device-id');

function getDeviceId() {
  try {
    if (existsSync(DEVICE_ID_FILE)) {
      return readFileSync(DEVICE_ID_FILE, 'utf8').trim();
    }
  } catch { /* ignore */ }
  const id = `badgr-auto-${randomUUID()}`;
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(DEVICE_ID_FILE, id, { mode: 0o600 });
  } catch { /* ignore */ }
  return id;
}

/**
 * Send one PostHog event. Fire-and-forget — never throws.
 */
function capture(event, properties) {
  if (!POSTHOG_KEY) return;
  const payload = {
    api_key: POSTHOG_KEY,
    event,
    distinct_id: getDeviceId(),
    timestamp: new Date().toISOString(),
    properties: {
      $lib: 'badgr-auto',
      ...properties,
    },
  };
  fetch(`${POSTHOG_HOST}/capture/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(4000),
  }).catch(() => { /* never surface analytics errors to callers */ });
}

/**
 * Track a completed proxy request.
 * Only aggregated metrics — no prompt text, no completion text.
 *
 * @param {object} entry - The log entry from buildLogEntry()
 */
export function trackRequest(entry) {
  capture('badgr_auto_request', {
    // Routing
    route_tier:      entry.routeTier,
    preferred_tier:  entry.preferredTier,
    fallback_used:   entry.routeFallbackUsed,
    route_reason:    entry.routeReason,

    // Model (not the prompt, just which model was selected)
    model:           entry.model,

    // Token optimization
    original_tokens:        entry.originalTokens,
    optimized_tokens:       entry.optimizedTokens,
    tokens_saved:           entry.tokensSaved,
    saved_percent:          entry.savedPercent,
    did_dedupe:             entry.didDedupe,
    did_compress:           entry.didCompress,

    // Cost
    estimated_savings_usd:  entry.estimatedSavingsUsd,
    actual_cost_usd:        entry.actualCostUsd,
    local_only:             entry.routeTier === 'edge',

    // Performance
    latency_ms:             entry.latencyMs,
    latency_target_ms:      entry.latencyTargetMs,
    streaming:              entry.streaming,
    status_code:            entry.statusCode,
  });
}

/**
 * Track a proxy error (upstream 5xx, network failure, etc.).
 * No prompt content included.
 */
export function trackError(fields) {
  capture('badgr_auto_error', {
    route_tier:   fields.routeTier,
    model:        fields.model,
    status_code:  fields.statusCode,
    error_type:   fields.errorType,
    streaming:    fields.streaming,
    retry_count:  fields.retryCount ?? 0,
    latency_ms:   fields.latencyMs,
  });
}
