import * as path from 'path';
import * as fs from 'fs';
import { runTests } from '@vscode/test-electron';

const SYSTEM_VSCODE_PATHS: Record<string, string[]> = {
  darwin: [
    '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
    '/Applications/Visual Studio Code - Insiders.app/Contents/MacOS/Electron',
  ],
  linux: [
    '/usr/share/code/code',
    '/usr/bin/code',
    '/snap/code/current/usr/share/code/code',
  ],
  win32: [
    `${process.env.LOCALAPPDATA}\\Programs\\Microsoft VS Code\\Code.exe`,
  ],
};

function findSystemVSCode(): string | undefined {
  const candidates = SYSTEM_VSCODE_PATHS[process.platform] ?? [];
  return candidates.find(p => fs.existsSync(p));
}

async function main() {
  // __dirname is out/test/suite — go up three levels to reach the extension root
  const extensionDevelopmentPath = path.resolve(__dirname, '../../../');
  const extensionTestsPath = path.resolve(__dirname, './index');

  const vscodeExecutablePath = findSystemVSCode();
  if (vscodeExecutablePath) {
    console.log(`Using system VS Code: ${vscodeExecutablePath}`);
  }

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      ...(vscodeExecutablePath ? { vscodeExecutablePath } : { version: 'stable' }),
      launchArgs: [
        '--disable-extensions',
        '--disable-workspace-trust',
        '--user-data-dir', path.join(extensionDevelopmentPath, '.vscode-test', 'user-data'),
      ],
    });
  } catch {
    console.error('VS Code extension tests failed');
    process.exit(1);
  }
}

main();
