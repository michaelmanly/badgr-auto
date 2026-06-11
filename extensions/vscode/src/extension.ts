import * as vscode from 'vscode';
import { StatusProvider } from './statusProvider';
import { ToolsProvider } from './toolsProvider';
import { ReceiptsPanel } from './receiptsPanel';
import { runSetupWizard } from './setupWizard';
import { configureTool, restoreToolConfig } from './toolConfigurator';
import {
  startProxy, stopProxy, openMonitor,
  getBaseUrl, checkHealth, isInstalled,
} from './proxyManager';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const statusProvider = new StatusProvider();
  const toolsProvider = new ToolsProvider();

  context.subscriptions.push(
    { dispose: () => statusProvider.dispose() },
    { dispose: () => toolsProvider.dispose() },
  );

  // Sidebar trees
  context.subscriptions.push(
    vscode.window.createTreeView('badgr.statusView', {
      treeDataProvider: statusProvider,
      showCollapseAll: false,
    }),
    vscode.window.createTreeView('badgr.toolsView', {
      treeDataProvider: toolsProvider,
      showCollapseAll: false,
    }),
  );

  // Status bar
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  bar.command = 'badgr.showReceipts';
  bar.text = '$(circle-outline) Badgr';
  bar.tooltip = 'Badgr Auto proxy — click to open receipts';
  bar.show();
  context.subscriptions.push(bar);

  const updateBar = async () => {
    const state = statusProvider.getProxyState();
    if (state === 'running') {
      bar.text = '$(circle-filled) Badgr';
      bar.tooltip = `Badgr Auto running at ${getBaseUrl()} — click for receipts`;
      bar.backgroundColor = undefined;
    } else if (state === 'broken') {
      bar.text = '$(warning) Badgr';
      bar.tooltip = 'Badgr Auto: proxy unreachable — click for receipts or run "Badgr: Start Proxy"';
      bar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      bar.text = '$(circle-outline) Badgr';
      bar.tooltip = 'Badgr Auto stopped — click for receipts';
      bar.backgroundColor = undefined;
    }
  };

  // statusProvider fires onDidChangeTreeData when it polls; hook into that
  context.subscriptions.push(
    statusProvider.onDidChangeTreeData(() => updateBar()),
  );
  updateBar();

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('badgr.startProxy', () => {
      startProxy();
      setTimeout(() => statusProvider.refresh(), 3000);
    }),

    vscode.commands.registerCommand('badgr.stopProxy', () => {
      stopProxy();
      setTimeout(() => statusProvider.refresh(), 2000);
    }),

    vscode.commands.registerCommand('badgr.openMonitor', () => openMonitor()),

    vscode.commands.registerCommand('badgr.showReceipts', () => ReceiptsPanel.createOrShow()),

    vscode.commands.registerCommand('badgr.copyBaseUrl', async () => {
      const url = getBaseUrl();
      await vscode.env.clipboard.writeText(url);
      vscode.window.showInformationMessage(`Copied: ${url}`);
    }),

    vscode.commands.registerCommand('badgr.setup', () => runSetupWizard()),

    vscode.commands.registerCommand('badgr.refreshStatus', () => statusProvider.refresh()),

    vscode.commands.registerCommand('badgr.restoreToolConfig', async (toolId?: string) => {
      if (!toolId) {
        const pick = await vscode.window.showQuickPick(
          [
            { label: 'Continue', id: 'continue' },
            { label: 'Aider', id: 'aider' },
            { label: 'GitHub Copilot (BYOK)', id: 'copilot' },
          ],
          { placeHolder: 'Restore config for which tool?' },
        );
        toolId = pick?.id;
      }
      if (toolId) {
        await restoreToolConfig(toolId);
        toolsProvider.refresh();
      }
    }),

    vscode.commands.registerCommand('badgr.configureTool', async (toolId?: string) => {
      if (!toolId) {
        const pick = await vscode.window.showQuickPick(
          [
            { label: '$(wrench) Continue', description: 'Auto-configure', id: 'continue' },
            { label: '$(wrench) Aider', description: 'Auto-configure', id: 'aider' },
            { label: '$(wrench) GitHub Copilot (BYOK)', description: 'Auto-configure', id: 'copilot' },
            { label: '$(info) Cline', description: 'Manual instructions', id: 'cline' },
            { label: '$(info) Roo Code', description: 'Manual instructions', id: 'roocode' },
            { label: '$(info) Kilo Code', description: 'Manual instructions', id: 'kilocode' },
          ],
          { placeHolder: 'Which tool to configure?' },
        );
        toolId = pick?.id;
      }
      if (toolId) {
        await configureTool(toolId, '');
        toolsProvider.refresh();
      }
    }),
  );

  // First-launch welcome — must not block activate(); headless tests never dismiss modals
  const welcomed = context.globalState.get<boolean>('badgr.welcomed');
  if (!welcomed) {
    void context.globalState.update('badgr.welcomed', true);
    void showWelcomePrompt();
  }

  // Auto-start if configured — fire-and-forget so activation completes immediately
  const cfg = vscode.workspace.getConfiguration('badgr');
  if (cfg.get<boolean>('autoStartProxy')) {
    void checkHealth().then(h => {
      if (!h.running) startProxy();
    });
  }
}

async function showWelcomePrompt(): Promise<void> {
  const inst = await isInstalled();
  const choice = await vscode.window.showInformationMessage(
    inst
      ? 'Badgr Auto is installed. Run the setup wizard to connect your tools?'
      : 'Welcome to Badgr Auto! Set up the local AI proxy?',
    'Run Setup Wizard',
    'Later',
  );
  if (choice === 'Run Setup Wizard') {
    void vscode.commands.executeCommand('badgr.setup');
  }
}

export function deactivate(): void {
  // providers disposed via context.subscriptions
}
