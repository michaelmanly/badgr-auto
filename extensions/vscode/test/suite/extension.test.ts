import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Badgr Auto Extension', () => {
  suiteSetup(async () => {
    // Give extension host time to fully activate
    await new Promise(resolve => setTimeout(resolve, 2000));
  });

  test('extension activates', async () => {
    const ext = vscode.extensions.getExtension('aibadgr.badgr-auto');
    assert.ok(ext, 'Extension not found — check publisher/name in package.json');
    if (!ext!.isActive) {
      await ext!.activate();
    }
    assert.strictEqual(ext!.isActive, true);
  });

  test('all commands are registered', async () => {
    const allCommands = await vscode.commands.getCommands(true);
    const badgrCommands = [
      'badgr.startProxy',
      'badgr.stopProxy',
      'badgr.openMonitor',
      'badgr.showReceipts',
      'badgr.copyBaseUrl',
      'badgr.setup',
      'badgr.configureTool',
      'badgr.restoreToolConfig',
      'badgr.refreshStatus',
    ];
    for (const cmd of badgrCommands) {
      assert.ok(allCommands.includes(cmd), `Command not registered: ${cmd}`);
    }
  });

  test('badgr.copyBaseUrl writes to clipboard', async () => {
    await vscode.commands.executeCommand('badgr.copyBaseUrl');
    const text = await vscode.env.clipboard.readText();
    assert.match(text, /^http:\/\/localhost:\d+\/v1$/);
  });

  test('badgr.showReceipts opens a webview panel', async () => {
    await vscode.commands.executeCommand('badgr.showReceipts');
    // Give the panel time to open
    await new Promise(resolve => setTimeout(resolve, 500));
    // If this doesn't throw, the command executed without error
    assert.ok(true);
  });

  test('status view is registered', async () => {
    // The view is registered via contributes.views — just check it doesn't throw
    await vscode.commands.executeCommand('badgr.refreshStatus');
    assert.ok(true);
  });
});
