import * as vscode from 'vscode';
import {
  isInstalled, checkHealth, readMainConfig,
  startProxy, installBadgrAuto, getBaseUrl,
} from './proxyManager';
import { configureTool } from './toolConfigurator';

export async function runSetupWizard(): Promise<void> {
  // ── Step 1: installation check ────────────────────────────────────────────
  const installed = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Badgr Auto: checking installation…', cancellable: false },
    () => isInstalled(),
  );

  if (!installed) {
    const choice = await vscode.window.showInformationMessage(
      'badgr-auto is not installed.',
      {
        modal: true,
        detail: 'Install it now with:\n  npm install -g badgr-auto\n\nA terminal will open and run this for you.',
      },
      'Install now',
      'Cancel',
    );
    if (choice !== 'Install now') return;
    installBadgrAuto();
    vscode.window.showInformationMessage(
      'Installing badgr-auto… watch the terminal. Re-run "Badgr: Setup Wizard" once it finishes.',
    );
    return;
  }

  // ── Step 2: proxy health ──────────────────────────────────────────────────
  let health = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Badgr Auto: checking proxy…', cancellable: false },
    () => checkHealth(),
  );

  if (!health.running) {
    const errorDetail = health.error
      ? `Error: ${health.error}\n\nThis usually means the proxy isn't running yet.`
      : 'The proxy is not running.';

    const choice = await vscode.window.showWarningMessage(
      'Proxy not reachable.',
      { modal: true, detail: `${errorDetail}\n\nStart it now?` },
      'Start proxy',
      'Skip',
    );

    if (choice === 'Start proxy') {
      startProxy();
      health = await waitForProxy(10);
    }
  }

  if (health.running) {
    vscode.window.showInformationMessage(
      `Proxy is running at ${health.baseUrl || getBaseUrl()}`,
    );
  } else {
    const cont = await vscode.window.showWarningMessage(
      'Proxy did not start within 10 s.',
      {
        modal: true,
        detail: 'You can still configure tools now and start the proxy later via "Badgr: Start Proxy".',
      },
      'Continue anyway',
      'Cancel',
    );
    if (cont !== 'Continue anyway') return;
  }

  // ── Step 3: tool configuration ────────────────────────────────────────────
  const config = readMainConfig();
  const apiKey = config.apiKey || '';

  const picks = [
    { label: '$(wrench) Continue', description: 'Auto-configure ~/.continue/config.yaml', id: 'continue' },
    { label: '$(wrench) Aider', description: 'Auto-configure ~/.aider.conf.yml', id: 'aider' },
    { label: '$(wrench) GitHub Copilot (BYOK)', description: 'Auto-configure chatLanguageModels.json', id: 'copilot' },
    { label: '$(info) Cline', description: 'Manual — config stored in private extension state', id: 'cline' },
    { label: '$(info) Roo Code', description: 'Manual — config stored in private extension state', id: 'roocode' },
    { label: '$(info) Kilo Code', description: 'Manual — show copy-paste steps', id: 'kilocode' },
    { label: '$(close) Skip', description: 'Configure tools later', id: 'skip' },
  ];

  const toolChoice = await vscode.window.showQuickPick(picks, {
    placeHolder: 'Which tool should route through Badgr Auto?',
  });

  if (!toolChoice || toolChoice.id === 'skip') return;

  let key = apiKey;
  if (['continue', 'aider', 'copilot'].includes(toolChoice.id) && !key) {
    key = await vscode.window.showInputBox({
      prompt: 'Enter your Badgr API key (from aibadgr.com/dashboard)',
      placeHolder: 'badgr_…',
      password: true,
    }) || '';
  }

  const result = await configureTool(toolChoice.id, key);

  if (result.success && result.backupPath) {
    const restore = await vscode.window.showInformationMessage(
      `Config written. Backup saved at ${result.backupPath}.`,
      'Restore original',
    );
    if (restore === 'Restore original') {
      await vscode.commands.executeCommand('badgr.restoreToolConfig', toolChoice.id);
    }
  }
}

async function waitForProxy(maxSeconds: number): Promise<Awaited<ReturnType<typeof checkHealth>>> {
  for (let i = 0; i < maxSeconds; i++) {
    await sleep(1000);
    const h = await checkHealth();
    if (h.running) return h;
  }
  return checkHealth();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
