import * as vscode from 'vscode';
import { checkHealth, readSessionStats, readReceipts, getBaseUrl, HealthStatus, SessionStats } from './proxyManager';

// Extended health state distinguishes "never started" vs "crashed after running"
type ProxyState = 'running' | 'stopped' | 'broken';

export class StatusItem extends vscode.TreeItem {
  constructor(label: string, description: string, icon: string, command?: vscode.Command) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.tooltip = `${label}: ${description}`;
    this.iconPath = new vscode.ThemeIcon(icon);
    if (command) this.command = command;
  }
}

export class StatusProvider implements vscode.TreeDataProvider<StatusItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _health: HealthStatus = { running: false, port: 8787 };
  private _proxyState: ProxyState = 'stopped';
  private _wasRunning = false; // tracks whether proxy was seen running this session
  private _stats: SessionStats = { tokensSaved: 0, costSaved: 0, requestCount: 0 };
  private _lastRoute = '';
  private _lastModel = '';
  private _consecutiveFailures = 0;
  private _pollTimer?: ReturnType<typeof setInterval>;

  constructor() {
    this._startPolling();
  }

  private _startPolling(): void {
    this._doRefresh();
    this._pollTimer = setInterval(() => this._doRefresh(), 5000);
  }

  private async _doRefresh(): Promise<void> {
    const prev = this._health.running;
    this._health = await checkHealth();

    if (this._health.running) {
      this._wasRunning = true;
      this._consecutiveFailures = 0;
      this._proxyState = 'running';
    } else {
      this._consecutiveFailures++;
      // "broken" = was running this session but is now unreachable for 2+ polls
      this._proxyState = (this._wasRunning && this._consecutiveFailures >= 2) ? 'broken' : 'stopped';
    }

    if (prev !== this._health.running) {
      // State changed — also refresh stats / recent receipt
      this._stats = readSessionStats();
      const recent = readReceipts(1);
      if (recent.length > 0) {
        this._lastRoute = recent[0].route_tier || '';
        this._lastModel = recent[0].model || '';
      }
    }

    this._onDidChangeTreeData.fire();
  }

  refresh(): void { this._doRefresh(); }

  dispose(): void {
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._onDidChangeTreeData.dispose();
  }

  getProxyState(): ProxyState { return this._proxyState; }

  getTreeItem(element: StatusItem): vscode.TreeItem { return element; }

  getChildren(): StatusItem[] {
    const { port } = this._health;
    const { tokensSaved, costSaved, requestCount } = this._stats;
    const state = this._proxyState;

    const statusLabel =
      state === 'running' ? 'Running' :
      state === 'broken'  ? 'Unreachable — click to restart' :
      'Stopped';
    const statusIcon =
      state === 'running' ? 'circle-filled' :
      state === 'broken'  ? 'warning' :
      'circle-outline';
    const statusCmd: vscode.Command | undefined =
      state !== 'running'
        ? { command: 'badgr.startProxy', title: 'Start Proxy' }
        : undefined;

    return [
      new StatusItem('Proxy', statusLabel, statusIcon, statusCmd),
      new StatusItem('Base URL', getBaseUrl(), 'link'),
      new StatusItem('Port', String(port), 'server'),
      new StatusItem('Last route', this._lastRoute || '—', 'arrow-right'),
      new StatusItem('Last model', this._lastModel || '—', 'symbol-misc'),
      new StatusItem(
        'Tokens saved',
        tokensSaved > 0 ? tokensSaved.toLocaleString() : '—',
        'dashboard',
      ),
      new StatusItem(
        'Cost saved',
        costSaved > 0 ? `$${costSaved.toFixed(4)}` : '—',
        'graph',
      ),
      new StatusItem(
        'Requests',
        requestCount > 0 ? String(requestCount) : '—',
        'list-unordered',
      ),
    ];
  }
}
