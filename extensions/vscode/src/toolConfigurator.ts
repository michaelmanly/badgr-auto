import * as vscode from 'vscode';
import {
  writeContinueConfig, writeAiderConfig, writeCopilotConfig,
  restoreConfig, hasBackupFor, ConfigResult,
} from './configWriter';
import { getBaseUrl, getPort } from './proxyManager';
import { TOOL_DEFS } from './toolsProvider';

export { ConfigResult, hasBackupFor } from './configWriter';

// ── Public API ────────────────────────────────────────────────────────────────

export async function configureTool(toolId: string, apiKey: string): Promise<ConfigResult> {
  let result: ConfigResult;
  const baseUrl = getBaseUrl();

  switch (toolId) {
    case 'continue':
      result = writeContinueConfig(baseUrl, apiKey);
      break;
    case 'aider':
      result = writeAiderConfig(baseUrl, apiKey);
      break;
    case 'copilot': {
      const completionsUrl = `http://localhost:${getPort()}/v1/chat/completions`;
      result = writeCopilotConfig(completionsUrl, apiKey);
      break;
    }
    default:
      result = await showManualInstructions(toolId);
      break;
  }

  if (result.success) {
    vscode.window.showInformationMessage(`Badgr Auto: ${result.message}`);
  } else if (result.message && !result.message.startsWith('Manual')) {
    vscode.window.showWarningMessage(`Badgr Auto: ${result.message}`);
  }
  return result;
}

export async function restoreToolConfig(toolId: string): Promise<boolean> {
  const r = restoreConfig(toolId);
  if (r.restored) {
    vscode.window.showInformationMessage(`Badgr Auto: ${r.message}`);
  } else {
    vscode.window.showInformationMessage(`Badgr Auto: ${r.message}`);
  }
  return r.restored;
}

// ── Manual instructions (unsafe tools) ───────────────────────────────────────

async function showManualInstructions(toolId: string): Promise<ConfigResult> {
  const def = TOOL_DEFS.find(d => d.id === toolId);
  if (!def) return { success: false, message: `Unknown tool: ${toolId}` };

  const detail = def.instructions.join('\n');
  const choice = await vscode.window.showInformationMessage(
    `Configure ${def.name}`,
    { modal: true, detail },
    'Copy Base URL',
    'Copy full snippet',
  );

  if (choice === 'Copy Base URL') {
    await vscode.env.clipboard.writeText(getBaseUrl());
    vscode.window.showInformationMessage(`Copied: ${getBaseUrl()}`);
  } else if (choice === 'Copy full snippet') {
    await vscode.env.clipboard.writeText(buildSnippet(toolId));
    vscode.window.showInformationMessage('Config snippet copied.');
  }

  return { success: false, message: 'Manual configuration — see the instructions shown.' };
}

function buildSnippet(toolId: string): string {
  const base = getBaseUrl();
  switch (toolId) {
    case 'cline':
    case 'roocode':
    case 'kilocode':
      return `Base URL: ${base}\nAPI Key: <YOUR_BADGR_API_KEY>\nModel: badgr-auto`;
    default:
      return `Base URL: ${base}`;
  }
}
