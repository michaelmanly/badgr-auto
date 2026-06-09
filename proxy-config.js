import { CONFIG_DIR } from './config.js';
import { join } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';

export const PROXY_CONFIG_FILE = join(CONFIG_DIR, 'auto-config.json');
export const PROXY_PID_FILE    = join(CONFIG_DIR, 'auto-proxy.pid');
export const PROXY_PORT        = Number.parseInt(process.env.BADGR_AUTO_PORT || '8787', 10);

export const CONFIG_DEFAULTS = {
  upstreamProvider: 'openai',
  upstreamBaseUrl: process.env.BADGR_AUTO_MID_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  edgeBaseUrl: process.env.BADGR_AUTO_EDGE_BASE_URL || '',
  midBaseUrl: process.env.BADGR_AUTO_MID_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  asyncBaseUrl: process.env.BADGR_AUTO_ASYNC_BASE_URL || '',
  premiumBaseUrl: process.env.BADGR_AUTO_PREMIUM_BASE_URL || '',
  edgeModel: process.env.BADGR_AUTO_EDGE_MODEL || 'local-small',
  midModel: process.env.BADGR_AUTO_MID_MODEL || 'gpt-4o-mini',
  asyncModel: process.env.BADGR_AUTO_ASYNC_MODEL || 'batch-oss',
  premiumModel: process.env.BADGR_AUTO_PREMIUM_MODEL || 'premium-reasoning',
  defaultModel: process.env.BADGR_AUTO_MID_MODEL || 'gpt-4o-mini',
  edgeMaxTokens: 768,
  premiumMinTokens: 4096,
  compressionThresholdTokens: 12000,
  recentMessagesToKeep: 8,
  summaryMaxTokens: 1600,
};

export function loadProxyConfig() {
  if (!existsSync(PROXY_CONFIG_FILE)) return { ...CONFIG_DEFAULTS };
  try {
    return { ...CONFIG_DEFAULTS, ...JSON.parse(readFileSync(PROXY_CONFIG_FILE, 'utf8')) };
  } catch {
    return { ...CONFIG_DEFAULTS };
  }
}

export function saveProxyConfig(updates) {
  const merged = { ...loadProxyConfig(), ...updates };
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(PROXY_CONFIG_FILE, JSON.stringify(merged, null, 2), { mode: 0o600 });
  return merged;
}

export function readProxyPid() {
  if (!existsSync(PROXY_PID_FILE)) return null;
  try {
    const pid = parseInt(readFileSync(PROXY_PID_FILE, 'utf8').trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

export function writeProxyPid(pid) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(PROXY_PID_FILE, String(pid), { encoding: 'utf8', mode: 0o600 });
}

export function clearProxyPid() {
  if (existsSync(PROXY_PID_FILE)) {
    try { unlinkSync(PROXY_PID_FILE); } catch { /* ignore */ }
  }
}

export function isProxyRunning() {
  const pid = readProxyPid();
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
