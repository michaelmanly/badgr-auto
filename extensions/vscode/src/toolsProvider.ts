import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { getPort } from './proxyManager';
import { getCopilotModelFiles } from './configWriter';

export interface ToolDef {
  id: string;
  name: string;
  extensionId?: string;
  canAutoConfig: boolean;
  instructions: string[];
}

const TOOL_DEFS: ToolDef[] = [
  {
    id: 'cline',
    name: 'Cline',
    extensionId: 'saoudrizwan.claude-dev',
    canAutoConfig: false,
    instructions: [
      'Open Cline → click the ⚙ settings icon',
      'API Provider → OpenAI Compatible',
      'Base URL: http://localhost:8787/v1',
      'API Key: your Badgr API key',
      'Model ID: badgr-auto',
    ],
  },
  {
    id: 'continue',
    name: 'Continue',
    extensionId: 'continue.continuedev',
    canAutoConfig: true,
    instructions: [
      'Add to ~/.continue/config.yaml:',
      'models:',
      '  - name: AI Badgr Auto',
      '    provider: openai',
      '    model: badgr-auto',
      '    apiBase: http://localhost:8787/v1',
      '    apiKey: <YOUR_BADGR_API_KEY>',
    ],
  },
  {
    id: 'roocode',
    name: 'Roo Code',
    extensionId: 'rooveterinaryinc.roo-cline',
    canAutoConfig: false,
    instructions: [
      'Open Roo Code → click the ⚙ settings icon',
      'API Provider → OpenAI Compatible',
      'Base URL: http://localhost:8787/v1',
      'API Key: your Badgr API key',
      'Model ID: badgr-auto',
    ],
  },
  {
    id: 'kilocode',
    name: 'Kilo Code',
    extensionId: 'kilocode.kilo-code',
    canAutoConfig: false,
    instructions: [
      'Open Kilo Code → Settings → Providers → Custom Provider',
      'Base URL: http://localhost:8787/v1',
      'API Key: your Badgr API key',
      'Model: badgr-auto',
    ],
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot (BYOK)',
    extensionId: 'github.copilot',
    canAutoConfig: true,
    instructions: [
      'Command Palette → Chat: Manage Language Models',
      'Select OpenAI Compatible',
      'URL: http://localhost:8787/v1/chat/completions',
      'API Key: your Badgr API key',
      'Model ID: badgr-auto',
      'Or: auto-configure writes chatLanguageModels.json',
    ],
  },
  {
    id: 'aider',
    name: 'Aider (terminal)',
    canAutoConfig: true,
    instructions: [
      'Set in ~/.aider.conf.yml:',
      'openai-api-base: http://localhost:8787/v1',
      'openai-api-key: <YOUR_BADGR_API_KEY>',
      'model: openai/badgr-auto',
    ],
  },
];

export class ToolItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly description: string,
    public readonly toolDef?: ToolDef,
    public readonly configured?: boolean,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.tooltip = label;
    this.iconPath = new vscode.ThemeIcon(configured ? 'pass-filled' : toolDef?.canAutoConfig ? 'wrench' : 'info');
    if (toolDef) {
      this.command = {
        command: 'badgr.configureTool',
        title: 'Configure',
        arguments: [toolDef.id],
      };
    }
  }
}

export class ToolsProvider implements vscode.TreeDataProvider<ToolItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void { this._onDidChangeTreeData.fire(); }

  dispose(): void { this._onDidChangeTreeData.dispose(); }

  getTreeItem(element: ToolItem): vscode.TreeItem { return element; }

  getChildren(): ToolItem[] {
    const items: ToolItem[] = [];
    let anyDetected = false;

    for (const def of TOOL_DEFS) {
      const installed = def.extensionId
        ? !!vscode.extensions.getExtension(def.extensionId)
        : def.id === 'aider'; // always show Aider since it's terminal-based

      if (!installed) continue;
      anyDetected = true;

      const configured = this._isConfigured(def.id);
      const hasBackup = this._hasBackup(def.id);
      const desc = configured
        ? `✓ configured${hasBackup ? ' (backup available)' : ''}`
        : def.canAutoConfig ? 'click to auto-configure' : 'click for instructions';
      items.push(new ToolItem(def.name, desc, def, configured));
    }

    if (!anyDetected) {
      items.push(new ToolItem(
        'No tools detected',
        'Install Cline, Continue, Roo Code, or Kilo Code',
      ));
      const aiderDef = TOOL_DEFS.find(d => d.id === 'aider')!;
      const aiderConfigured = this._isConfigured('aider');
      const aiderBackup = this._hasBackup('aider');
      items.push(new ToolItem(
        'Aider',
        aiderConfigured ? `✓ configured${aiderBackup ? ' (backup available)' : ''}` : 'click to configure',
        aiderDef,
        aiderConfigured,
      ));
    }

    return items;
  }

  private _isConfigured(toolId: string): boolean {
    const proxyUrl = `localhost:${getPort()}`;
    try {
      if (toolId === 'continue') {
        for (const f of [
          path.join(os.homedir(), '.continue', 'config.yaml'),
          path.join(os.homedir(), '.continue', 'config.json'),
        ]) {
          if (fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes(proxyUrl)) return true;
        }
      }
      if (toolId === 'aider') {
        const f = path.join(os.homedir(), '.aider.conf.yml');
        return fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes(proxyUrl);
      }
      if (toolId === 'copilot') {
        const candidates = getCopilotModelFiles();
        for (const f of candidates) {
          if (fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes(proxyUrl)) return true;
        }
      }
    } catch { /* ignore */ }
    return false;
  }

  private _hasBackup(toolId: string): boolean {
    const paths: string[] = {
      continue: [
        path.join(os.homedir(), '.continue', 'config.yaml'),
        path.join(os.homedir(), '.continue', 'config.json'),
      ],
      aider: [path.join(os.homedir(), '.aider.conf.yml')],
      copilot: getCopilotModelFiles(),
    }[toolId] || [];
    return paths.some(p => fs.existsSync(p + '.badgr-backup'));
  }
}

export { getCopilotModelFiles } from './configWriter';
export { TOOL_DEFS };
