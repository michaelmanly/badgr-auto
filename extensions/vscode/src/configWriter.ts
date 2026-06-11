/**
 * Pure file I/O for tool config writing — no vscode dependency.
 * Imported by toolConfigurator.ts (vscode layer) and unit tests alike.
 *
 * All public functions accept an optional `homeDir` parameter so tests
 * can point them at a temp directory without mocking os.homedir.
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';

export interface ConfigResult {
  success: boolean;
  backupPath?: string;
  configPath?: string;
  message: string;
}

// ── Path helpers ──────────────────────────────────────────────────────────────

export function backupPathFor(originalPath: string): string {
  return originalPath + '.badgr-backup';
}

export function configPathsFor(toolId: string, homeDir?: string): string[] {
  const home = homeDir ?? os.homedir();
  switch (toolId) {
    case 'continue':
      return [
        path.join(home, '.continue', 'config.yaml'),
        path.join(home, '.continue', 'config.json'),
      ];
    case 'aider':
      return [path.join(home, '.aider.conf.yml')];
    case 'copilot':
      return getCopilotModelFiles(homeDir);
    default:
      return [];
  }
}

export function getCopilotModelFiles(homeDir?: string): string[] {
  const home = homeDir ?? os.homedir();
  const plat = process.platform;
  if (plat === 'darwin') {
    const base = path.join(home, 'Library', 'Application Support');
    return [
      path.join(base, 'Cursor', 'User', 'chatLanguageModels.json'),
      path.join(base, 'Cursor - Insiders', 'User', 'chatLanguageModels.json'),
      path.join(base, 'Code', 'User', 'chatLanguageModels.json'),
      path.join(base, 'Code - Insiders', 'User', 'chatLanguageModels.json'),
    ];
  }
  if (plat === 'win32') {
    const appdata = process.env.APPDATA || home;
    return [
      path.join(appdata, 'Cursor', 'User', 'chatLanguageModels.json'),
      path.join(appdata, 'Cursor - Insiders', 'User', 'chatLanguageModels.json'),
      path.join(appdata, 'Code', 'User', 'chatLanguageModels.json'),
      path.join(appdata, 'Code - Insiders', 'User', 'chatLanguageModels.json'),
    ];
  }
  const base = path.join(home, '.config');
  return [
    path.join(base, 'Cursor', 'User', 'chatLanguageModels.json'),
    path.join(base, 'Cursor - Insiders', 'User', 'chatLanguageModels.json'),
    path.join(base, 'Code', 'User', 'chatLanguageModels.json'),
    path.join(base, 'Code - Insiders', 'User', 'chatLanguageModels.json'),
  ];
}

export function hasBackupFor(toolId: string, homeDir?: string): boolean {
  return configPathsFor(toolId, homeDir).some(p => fs.existsSync(backupPathFor(p)));
}

// ── Backup helpers ────────────────────────────────────────────────────────────

export function backupFile(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const bp = backupPathFor(filePath);
  fs.copyFileSync(filePath, bp);
  return bp;
}

// ── Per-tool writers ──────────────────────────────────────────────────────────

export function writeContinueConfig(baseUrl: string, apiKey: string, homeDir?: string): ConfigResult {
  const home = homeDir ?? os.homedir();
  const continueDir = path.join(home, '.continue');
  const yamlPath = path.join(continueDir, 'config.yaml');
  const jsonPath = path.join(continueDir, 'config.json');

  const entry = {
    name: 'AI Badgr Auto',
    provider: 'openai',
    model: 'badgr-auto',
    apiBase: baseUrl,
    apiKey: apiKey || 'your-badgr-api-key',
  };

  if (fs.existsSync(yamlPath)) {
    return writeAndValidate(yamlPath, () => {
      const raw = fs.readFileSync(yamlPath, 'utf8');
      const config = (yaml.load(raw) || {}) as Record<string, unknown>;
      const models = (config.models as Record<string, unknown>[]) || [];
      if (models.some(m => m?.apiBase === baseUrl)) return null;
      models.push(entry);
      config.models = models;
      fs.writeFileSync(yamlPath, yaml.dump(config, { lineWidth: -1 }));
      return yamlPath;
    }, () => validateContinueFile(yamlPath, baseUrl));
  }

  if (fs.existsSync(jsonPath)) {
    return writeAndValidate(jsonPath, () => {
      const config = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as { models?: Record<string, unknown>[] };
      const models = config.models || [];
      if (models.some(m => m?.apiBase === baseUrl)) return null;
      models.push(entry);
      config.models = models;
      fs.writeFileSync(jsonPath, JSON.stringify(config, null, 2));
      return jsonPath;
    }, () => validateContinueFile(jsonPath, baseUrl));
  }

  // No existing config — create config.yaml
  try {
    fs.mkdirSync(continueDir, { recursive: true });
    fs.writeFileSync(yamlPath, yaml.dump({ models: [entry] }, { lineWidth: -1 }));
    if (!validateContinueFile(yamlPath, baseUrl)) throw new Error('Validation failed');
    return { success: true, configPath: yamlPath, message: 'Created ~/.continue/config.yaml with AI Badgr Auto.' };
  } catch (e) {
    return { success: false, message: `Failed to create Continue config: ${e}` };
  }
}

export function writeAiderConfig(baseUrl: string, apiKey: string, homeDir?: string): ConfigResult {
  const home = homeDir ?? os.homedir();
  const confPath = path.join(home, '.aider.conf.yml');
  const key = apiKey || 'your-badgr-api-key';

  if (fs.existsSync(confPath) && fs.readFileSync(confPath, 'utf8').includes(baseUrl)) {
    return { success: true, configPath: confPath, message: 'Aider already configured.' };
  }

  const block = [
    '# Badgr Auto — added by VS Code extension',
    `openai-api-base: ${baseUrl}`,
    `openai-api-key: ${key}`,
    'model: openai/badgr-auto',
  ].join('\n');

  return writeAndValidate(confPath, () => {
    const existing = fs.existsSync(confPath) ? fs.readFileSync(confPath, 'utf8').trimEnd() + '\n\n' : '';
    fs.writeFileSync(confPath, existing + block + '\n');
    return confPath;
  }, () => {
    try { return fs.readFileSync(confPath, 'utf8').includes(baseUrl); }
    catch { return false; }
  });
}

export function writeCopilotConfig(completionsUrl: string, apiKey: string, homeDir?: string): ConfigResult {
  const key = apiKey || 'your-badgr-api-key';
  const model = {
    id: 'badgr-auto',
    name: 'AI Badgr Auto',
    url: completionsUrl,
    vendor: 'customendpoint',
    toolCalling: true,
    vision: false,
    maxInputTokens: 128000,
    maxOutputTokens: 8192,
    apiKey: key,
  };

  for (const filePath of getCopilotModelFiles(homeDir)) {
    if (!fs.existsSync(path.dirname(filePath))) continue;
    if (fs.existsSync(filePath)) {
      const existing = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { models?: { url?: string }[] };
      if ((existing.models || []).some(m => m.url === completionsUrl)) {
        return { success: true, configPath: filePath, message: 'Copilot already configured.' };
      }
    }
    return writeAndValidate(filePath, () => {
      let config: { models?: typeof model[] } = { models: [] };
      if (fs.existsSync(filePath)) {
        config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!Array.isArray(config.models)) config.models = [];
      }
      config.models!.push(model);
      fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
      return filePath;
    }, () => {
      try {
        const cfg = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { models?: { url?: string }[] };
        return (cfg.models || []).some(m => m.url === completionsUrl);
      } catch { return false; }
    });
  }
  return { success: false, message: 'No writable Copilot config path found.' };
}

export function restoreConfig(
  toolId: string,
  homeDir?: string,
): { restored: boolean; path?: string; message: string } {
  for (const p of configPathsFor(toolId, homeDir)) {
    const bp = backupPathFor(p);
    if (fs.existsSync(bp)) {
      try {
        fs.copyFileSync(bp, p);
        fs.unlinkSync(bp);
        return { restored: true, path: p, message: `Restored ${path.basename(p)} from backup.` };
      } catch (e) {
        return { restored: false, message: `Restore failed: ${e}` };
      }
    }
  }
  return { restored: false, message: `No backup found for ${toolId}.` };
}

// ── Validation ────────────────────────────────────────────────────────────────

export function validateContinueFile(filePath: string, expectedBase: string): boolean {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
      const cfg = yaml.load(raw) as { models?: { apiBase?: string }[] };
      return (cfg?.models || []).some(m => m?.apiBase === expectedBase);
    }
    const cfg = JSON.parse(raw) as { models?: { apiBase?: string }[] };
    return (cfg?.models || []).some(m => m?.apiBase === expectedBase);
  } catch { return false; }
}

// ── Core write + validate + auto-restore ─────────────────────────────────────

export function writeAndValidate(
  configPath: string,
  write: () => string | null,
  validate: () => boolean,
): ConfigResult {
  const bp = backupFile(configPath);
  try {
    const written = write();
    if (written === null) {
      if (bp) { try { fs.unlinkSync(bp); } catch { /* ignore */ } }
      return { success: true, configPath, message: 'Already configured — no changes made.' };
    }
    if (!validate()) {
      if (bp) { try { fs.copyFileSync(bp, configPath); fs.unlinkSync(bp); } catch { /* ignore */ } }
      return { success: false, configPath, message: 'Write succeeded but validation failed. Original restored.' };
    }
    return {
      success: true,
      configPath,
      backupPath: bp ?? undefined,
      message: `Configured${bp ? ` (backup at ${path.basename(bp)})` : ''}.`,
    };
  } catch (e) {
    if (bp && fs.existsSync(bp)) {
      try { fs.copyFileSync(bp, configPath); fs.unlinkSync(bp); } catch { /* best-effort */ }
    }
    return { success: false, configPath, message: `Error writing config: ${e}` };
  }
}
