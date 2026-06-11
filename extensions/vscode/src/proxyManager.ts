import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import { exec } from 'child_process';

export const BADGR_CONFIG_DIR = process.env.BADGR_CONFIG_DIR?.trim() || path.join(os.homedir(), '.badgr');
export const PROXY_CONFIG_FILE = path.join(BADGR_CONFIG_DIR, 'auto-config.json');
export const MAIN_CONFIG_FILE = path.join(BADGR_CONFIG_DIR, 'config.json');
export const RECEIPTS_JSONL = path.join(BADGR_CONFIG_DIR, 'auto-requests.jsonl');
export const PID_FILE = path.join(BADGR_CONFIG_DIR, 'auto-proxy.pid');

export interface HealthStatus {
  running: boolean;
  port: number;
  baseUrl?: string;
  error?: string;
}

export interface ProxyConfig {
  routingMode?: string;
  tokenOptimization?: boolean;
  setupComplete?: boolean;
  [key: string]: unknown;
}

export interface MainConfig {
  apiKey?: string;
  baseUrl?: string;
}

export interface Receipt {
  id?: number;
  created_at: string;
  model?: string;
  original_tokens: number;
  optimized_tokens: number;
  tokens_saved: number;
  saved_percent: number;
  estimated_savings_usd: number;
  actual_cost_usd?: number;
  latency_ms: number;
  status_code?: number;
  route_tier?: string;
  preferred_tier?: string;
  route_reason?: string;
  route_fallback_used?: number;
  deduped?: number;
  compressed?: number;
  streaming?: number;
  client?: string;
  client_profile?: string;
}

export interface SessionStats {
  tokensSaved: number;
  costSaved: number;
  requestCount: number;
}

export function getPort(): number {
  const cfg = vscode.workspace.getConfiguration('badgr');
  const cfgPort = cfg.get<number>('port');
  if (cfgPort && cfgPort !== 8787) return cfgPort;
  try {
    if (fs.existsSync(PROXY_CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(PROXY_CONFIG_FILE, 'utf8'));
      if (typeof raw.port === 'number') return raw.port;
    }
  } catch { /* use default */ }
  return 8787;
}

export function getBaseUrl(): string {
  return `http://localhost:${getPort()}/v1`;
}

export async function isInstalled(): Promise<boolean> {
  return new Promise(resolve => {
    // badgr-auto has no --version flag; status exits 0 when the CLI is on PATH
    exec('badgr-auto status', (err: Error | null) => resolve(!err));
  });
}

export function checkHealth(): Promise<HealthStatus> {
  const port = getPort();
  return new Promise(resolve => {
    const req = http.get(`http://localhost:${port}/health`, { timeout: 3000 }, (res: http.IncomingMessage) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        try {
          const body = JSON.parse(data);
          resolve({ running: body.status === 'ok', port, baseUrl: body.base_url });
        } catch {
          resolve({ running: false, port, error: 'Invalid response' });
        }
      });
    });
    req.on('error', (err: Error) => resolve({ running: false, port, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ running: false, port, error: 'Timeout' }); });
  });
}

export function readProxyConfig(): ProxyConfig {
  try {
    if (fs.existsSync(PROXY_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(PROXY_CONFIG_FILE, 'utf8'));
    }
  } catch { /* ignore */ }
  return {};
}

export function readMainConfig(): MainConfig {
  try {
    if (fs.existsSync(MAIN_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(MAIN_CONFIG_FILE, 'utf8'));
    }
  } catch { /* ignore */ }
  return {};
}

export function readReceipts(limit = 50): Receipt[] {
  try {
    if (!fs.existsSync(RECEIPTS_JSONL)) return [];
    const content = fs.readFileSync(RECEIPTS_JSONL, 'utf8').trim();
    if (!content) return [];
    const lines = content.split('\n').filter(Boolean);
    const recent = lines.slice(-limit);
    return recent
      .map((line: string, i: number) => {
        try {
          const r = JSON.parse(line) as Receipt;
          r.id = r.id ?? (lines.length - recent.length + i + 1);
          return r;
        } catch { return null; }
      })
      .filter((r): r is Receipt => r !== null)
      .reverse();
  } catch { return []; }
}

export function readSessionStats(): SessionStats {
  const receipts = readReceipts(500);
  return {
    tokensSaved: receipts.reduce((s, r) => s + (r.tokens_saved || 0), 0),
    costSaved: receipts.reduce((s, r) => s + (r.estimated_savings_usd || 0), 0),
    requestCount: receipts.length,
  };
}

let _proxyTerminal: vscode.Terminal | undefined;

function getProxyTerminal(): vscode.Terminal {
  if (_proxyTerminal && _proxyTerminal.exitStatus === undefined) return _proxyTerminal;
  _proxyTerminal = vscode.window.createTerminal({ name: 'Badgr Auto' });
  return _proxyTerminal;
}

export function startProxy(): void {
  const t = getProxyTerminal();
  t.show(true);
  t.sendText('badgr-auto start');
}

export function stopProxy(): void {
  const t = getProxyTerminal();
  t.show(true);
  t.sendText('badgr-auto stop');
}

export function openMonitor(): void {
  const t = getProxyTerminal();
  t.show(true);
  t.sendText('badgr-auto monitor');
}

export function installBadgrAuto(): void {
  const t = vscode.window.createTerminal({ name: 'Install Badgr Auto' });
  t.show(true);
  t.sendText('npm install -g badgr-auto && echo "✓ badgr-auto installed. Run: badgr-auto start"');
}
