import { CONFIG_DIR, DEFAULT_UPSTREAM_BASE_URL } from './config.js';
import { join } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';

export const PROXY_CONFIG_FILE = join(CONFIG_DIR, 'auto-config.json');
export const PROXY_PID_FILE    = join(CONFIG_DIR, 'auto-proxy.pid');
export const PROXY_PORT        = Number.parseInt(process.env.BADGR_AUTO_PORT || '8787', 10);

export const CONFIG_DEFAULTS = {
  upstreamProvider: 'badgr',
  upstreamBaseUrl: DEFAULT_UPSTREAM_BASE_URL,
  edgeBaseUrl: '',
  midBaseUrl: DEFAULT_UPSTREAM_BASE_URL,
  asyncBaseUrl: '',
  premiumBaseUrl: '',
  edgeModel: process.env.BADGR_AUTO_EDGE_MODEL || 'qwen2.5-coder:7b',
  midModel: process.env.BADGR_AUTO_MID_MODEL || 'deepseek-chat',
  asyncModel: process.env.BADGR_AUTO_ASYNC_MODEL || 'batch-oss',
  premiumModel: process.env.BADGR_AUTO_PREMIUM_MODEL || 'claude-sonnet-4-5',
  defaultModel: process.env.BADGR_AUTO_MID_MODEL || 'deepseek-chat',
  edgeMaxTokens: 500,
  premiumMinTokens: 4096,
  compressionThresholdTokens: 12000,
  recentMessagesToKeep: 8,
  summaryMaxTokens: 1600,
  setupComplete: false,
  routingMode: 'direct',
  tokenOptimization: true,
  savingsStats: true,
};

const ENV_URL_KEYS = {
  BADGR_AUTO_UPSTREAM_BASE_URL: 'upstreamBaseUrl',
  BADGR_AUTO_MID_BASE_URL: 'midBaseUrl',
  BADGR_AUTO_EDGE_BASE_URL: 'edgeBaseUrl',
  BADGR_AUTO_ASYNC_BASE_URL: 'asyncBaseUrl',
  BADGR_AUTO_PREMIUM_BASE_URL: 'premiumBaseUrl',
};

function envProxyOverrides() {
  const overrides = {};
  for (const [envKey, configKey] of Object.entries(ENV_URL_KEYS)) {
    const value = process.env[envKey]?.trim();
    if (value) overrides[configKey] = value.replace(/\/+$/, '');
  }
  return overrides;
}

export function loadProxyConfig() {
  let config = { ...CONFIG_DEFAULTS };
  if (existsSync(PROXY_CONFIG_FILE)) {
    try {
      config = { ...config, ...JSON.parse(readFileSync(PROXY_CONFIG_FILE, 'utf8')) };
    } catch { /* use defaults */ }
  }
  return { ...config, ...envProxyOverrides() };
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
