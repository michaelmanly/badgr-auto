import * as vscode from 'vscode';
import { readReceipts, Receipt } from './proxyManager';

export class ReceiptsPanel {
  static currentPanel: ReceiptsPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel) {
    this._panel = panel;
    this._render();
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(msg => {
      if (msg.command === 'refresh') this._render();
    }, null, this._disposables);
  }

  static createOrShow(): void {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Beside
      : vscode.ViewColumn.One;

    if (ReceiptsPanel.currentPanel) {
      ReceiptsPanel.currentPanel._panel.reveal(column);
      ReceiptsPanel.currentPanel._render();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'badgrReceipts',
      'Badgr Receipts',
      column,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    ReceiptsPanel.currentPanel = new ReceiptsPanel(panel);
  }

  private _render(): void {
    this._panel.webview.html = buildHtml(readReceipts(200));
  }

  dispose(): void {
    ReceiptsPanel.currentPanel = undefined;
    this._panel.dispose();
    for (const d of this._disposables) d.dispose();
  }
}

function fmt(n: number | undefined, decimals = 0): string {
  if (n === undefined || n === null || n === 0) return '—';
  return decimals > 0 ? n.toFixed(decimals) : n.toLocaleString();
}

function buildHtml(receipts: Receipt[]): string {
  const rows = receipts.map(r => {
    const time = new Date(r.created_at).toLocaleTimeString();
    const model = r.model || '—';
    const route = r.route_tier || '—';
    const tokens = r.original_tokens
      ? `${r.original_tokens.toLocaleString()} → ${(r.optimized_tokens || 0).toLocaleString()}`
      : '—';
    const saved = r.tokens_saved > 0
      ? `${r.tokens_saved.toLocaleString()} (${r.saved_percent?.toFixed(0) || 0}%)`
      : '—';
    const cost = r.estimated_savings_usd > 0 ? `$${r.estimated_savings_usd.toFixed(4)}` : '—';
    const latency = r.latency_ms ? `${r.latency_ms}ms` : '—';
    const sc = r.status_code || 0;
    const statusClass = sc >= 400 ? ' class="err"' : '';

    const badges: string[] = [];
    if (r.deduped) badges.push('<span class="badge">deduped</span>');
    if (r.compressed) badges.push('<span class="badge">compressed</span>');
    if (r.route_fallback_used) badges.push('<span class="badge warn">fallback</span>');
    if (r.client_profile) badges.push(`<span class="badge muted">${r.client_profile}</span>`);

    const reason = r.route_reason ? `<div class="reason">${escHtml(r.route_reason)}</div>` : '';

    return `<tr${statusClass}>
      <td>${escHtml(time)}</td>
      <td>${escHtml(model)}</td>
      <td>${escHtml(route)}</td>
      <td>${escHtml(tokens)}</td>
      <td>${escHtml(saved)}</td>
      <td>${escHtml(cost)}</td>
      <td>${escHtml(latency)}</td>
      <td>${sc || '?'} ${badges.join('')}${reason}</td>
    </tr>`;
  }).join('\n');

  const tableOrEmpty = receipts.length === 0
    ? '<div class="empty">No receipts yet. Start the proxy and send a request from Cline, Continue, or another tool.</div>'
    : `<table>
        <thead><tr>
          <th>Time</th><th>Model</th><th>Route</th><th>Tokens</th>
          <th>Saved</th><th>Cost saved</th><th>Latency</th><th>Status</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>Badgr Receipts</title>
<style>
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-foreground);
    --border: var(--vscode-panel-border);
    --muted: var(--vscode-descriptionForeground);
    --hover: var(--vscode-list-hoverBackground);
    --err: var(--vscode-errorForeground);
    --badge-bg: var(--vscode-badge-background);
    --badge-fg: var(--vscode-badge-foreground);
    --btn-bg: var(--vscode-button-background);
    --btn-fg: var(--vscode-button-foreground);
    --btn-hover: var(--vscode-button-hoverBackground);
    --warn-bg: var(--vscode-inputValidation-warningBackground, #6b5300);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--fg); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); padding: 16px; }
  h1 { font-size: 1.1em; font-weight: 600; margin-bottom: 12px; }
  .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
  button { background: var(--btn-bg); color: var(--btn-fg); border: none; padding: 4px 14px; border-radius: 2px; cursor: pointer; font-size: 0.85em; }
  button:hover { background: var(--btn-hover); }
  .count { color: var(--muted); font-size: 0.82em; }
  table { width: 100%; border-collapse: collapse; font-size: 0.83em; }
  th { text-align: left; padding: 5px 10px; border-bottom: 1px solid var(--border); color: var(--muted); font-weight: 600; white-space: nowrap; }
  td { padding: 5px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; vertical-align: top; }
  tr:hover td { background: var(--hover); }
  tr.err td { color: var(--err); }
  .badge { background: var(--badge-bg); color: var(--badge-fg); border-radius: 3px; padding: 1px 5px; font-size: 0.78em; margin-left: 3px; }
  .badge.warn { background: var(--warn-bg); }
  .badge.muted { background: transparent; color: var(--muted); border: 1px solid var(--border); }
  .reason { color: var(--muted); font-size: 0.78em; margin-top: 2px; white-space: normal; max-width: 260px; }
  .empty { color: var(--muted); text-align: center; padding: 48px 16px; line-height: 1.6; }
</style>
</head>
<body>
<h1>Badgr Receipts</h1>
<div class="toolbar">
  <button onclick="refresh()">↻ Refresh</button>
  <span class="count">${receipts.length} receipt${receipts.length !== 1 ? 's' : ''}</span>
</div>
${tableOrEmpty}
<script>
  const vscode = acquireVsCodeApi();
  function refresh() { vscode.postMessage({ command: 'refresh' }); }
</script>
</body>
</html>`;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
