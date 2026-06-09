import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

export const CONFIG_DIR = process.env.BADGR_CONFIG_DIR?.trim()
  ? process.env.BADGR_CONFIG_DIR.trim()
  : join(homedir(), '.badgr');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export const DEFAULT_UPSTREAM_BASE_URL = 'https://aibadgr.com/v1';

export const DEFAULTS = {
  baseUrl: DEFAULT_UPSTREAM_BASE_URL,
};

const LEGACY_BASE_URLS = new Set([
  'https://api.badgr.ai/v1', 'https://api.badgr.ai',
  'https://api.aibadgr.com/v1', 'https://api.aibadgr.com',
]);

export function normalizeBaseUrl(url) {
  if (!url?.trim()) return DEFAULTS.baseUrl;
  const trimmed = url.trim().replace(/\/+$/, '');
  if (LEGACY_BASE_URLS.has(trimmed)) return DEFAULTS.baseUrl;
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

function applyEnvOverrides(config) {
  const envBase = process.env.BADGR_API_URL?.trim();
  if (envBase) config.baseUrl = normalizeBaseUrl(envBase);
  const envKey = process.env.BADGR_API_KEY?.trim();
  if (envKey) config.apiKey = envKey;
  return config;
}

export function loadConfig(configFile = CONFIG_FILE) {
  if (!existsSync(configFile)) return applyEnvOverrides({ ...DEFAULTS });
  try {
    const parsed = JSON.parse(readFileSync(configFile, 'utf8'));
    return applyEnvOverrides({
      ...DEFAULTS,
      ...parsed,
      baseUrl: normalizeBaseUrl(parsed.baseUrl ?? DEFAULTS.baseUrl),
    });
  } catch {
    return applyEnvOverrides({ ...DEFAULTS });
  }
}

export function saveConfig(updates, configFile = CONFIG_FILE) {
  const existing = loadConfig(configFile);
  const merged = { ...existing, ...updates };
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, JSON.stringify(merged, null, 2));
  return merged;
}
