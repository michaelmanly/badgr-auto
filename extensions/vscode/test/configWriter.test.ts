import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';

import {
  writeContinueConfig,
  writeAiderConfig,
  writeCopilotConfig,
  restoreConfig,
  hasBackupFor,
  backupPathFor,
  validateContinueFile,
  writeAndValidate,
} from '../src/configWriter';

const BASE_URL = 'http://localhost:8787/v1';
const API_KEY = 'test-key-123';
const COMPLETIONS_URL = 'http://localhost:8787/v1/chat/completions';

// Each test run gets its own temp directory
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'badgr-test-'));

// ── helpers ───────────────────────────────────────────────────────────────────

function continueDir() { return path.join(TMP, '.continue'); }
function yamlConfig() { return path.join(continueDir(), 'config.yaml'); }
function jsonConfig() { return path.join(continueDir(), 'config.json'); }
function aiderConfig() { return path.join(TMP, '.aider.conf.yml'); }

function clean(...files: string[]) {
  for (const f of files) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
    try { fs.unlinkSync(backupPathFor(f)); } catch { /* ignore */ }
  }
}

// ── Continue YAML ──────────────────────────────────────────────────────────────

describe('writeContinueConfig — YAML', () => {
  beforeEach(() => {
    fs.mkdirSync(continueDir(), { recursive: true });
    clean(yamlConfig());
  });

  it('creates config.yaml when none exists', () => {
    const r = writeContinueConfig(BASE_URL, API_KEY, TMP);
    expect(r.success).toBe(true);
    expect(fs.existsSync(yamlConfig())).toBe(true);
    expect(validateContinueFile(yamlConfig(), BASE_URL)).toBe(true);
  });

  it('appends to existing config.yaml', () => {
    const existing = { models: [{ name: 'GPT-4', provider: 'openai', model: 'gpt-4' }] };
    fs.writeFileSync(yamlConfig(), yaml.dump(existing));

    const r = writeContinueConfig(BASE_URL, API_KEY, TMP);
    expect(r.success).toBe(true);

    const cfg = yaml.load(fs.readFileSync(yamlConfig(), 'utf8')) as { models: { apiBase?: string }[] };
    expect(cfg.models).toHaveLength(2);
    expect(cfg.models.some(m => m.apiBase === BASE_URL)).toBe(true);
  });

  it('creates a backup before modifying', () => {
    fs.writeFileSync(yamlConfig(), yaml.dump({ models: [] }));
    const r = writeContinueConfig(BASE_URL, API_KEY, TMP);
    expect(r.backupPath).toBeDefined();
    expect(fs.existsSync(r.backupPath!)).toBe(true);
  });

  it('is idempotent — no-op if already configured', () => {
    writeContinueConfig(BASE_URL, API_KEY, TMP);
    clean(backupPathFor(yamlConfig())); // discard first backup
    const r2 = writeContinueConfig(BASE_URL, API_KEY, TMP);
    expect(r2.success).toBe(true);
    expect(r2.message).toMatch(/Already configured/);
    expect(r2.backupPath).toBeUndefined();
  });

  it('restores backup on validation failure', () => {
    const original = yaml.dump({ models: [{ name: 'existing' }] });
    fs.writeFileSync(yamlConfig(), original);

    const r = writeAndValidate(
      yamlConfig(),
      () => { fs.writeFileSync(yamlConfig(), 'garbage: [bad yaml: unclosed'); return yamlConfig(); },
      () => false,
    );

    expect(r.success).toBe(false);
    expect(r.message).toMatch(/restored/i);
    expect(fs.readFileSync(yamlConfig(), 'utf8')).toBe(original);
    expect(fs.existsSync(backupPathFor(yamlConfig()))).toBe(false);
  });
});

// ── Continue JSON (fallback) ───────────────────────────────────────────────────

describe('writeContinueConfig — JSON fallback', () => {
  beforeEach(() => {
    fs.mkdirSync(continueDir(), { recursive: true });
    clean(yamlConfig(), jsonConfig());
  });

  it('writes to config.json when no yaml exists', () => {
    fs.writeFileSync(jsonConfig(), JSON.stringify({ models: [] }));
    const r = writeContinueConfig(BASE_URL, API_KEY, TMP);
    expect(r.success).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(jsonConfig(), 'utf8'));
    expect(cfg.models.some((m: { apiBase?: string }) => m.apiBase === BASE_URL)).toBe(true);
  });

  it('creates a backup of existing JSON', () => {
    fs.writeFileSync(jsonConfig(), JSON.stringify({ models: [] }));
    const r = writeContinueConfig(BASE_URL, API_KEY, TMP);
    expect(r.backupPath).toBeDefined();
    expect(fs.existsSync(r.backupPath!)).toBe(true);
  });
});

// ── restoreConfig ──────────────────────────────────────────────────────────────

describe('restoreConfig — Continue', () => {
  beforeEach(() => {
    fs.mkdirSync(continueDir(), { recursive: true });
    clean(yamlConfig());
  });

  it('restores original file and removes backup', () => {
    const original = yaml.dump({ models: [] });
    fs.writeFileSync(yamlConfig(), original);

    writeContinueConfig(BASE_URL, API_KEY, TMP);
    expect(fs.existsSync(backupPathFor(yamlConfig()))).toBe(true);

    const r = restoreConfig('continue', TMP);
    expect(r.restored).toBe(true);
    expect(fs.readFileSync(yamlConfig(), 'utf8')).toBe(original);
    expect(fs.existsSync(backupPathFor(yamlConfig()))).toBe(false);
  });

  it('reports no backup if none exists', () => {
    const r = restoreConfig('continue', TMP);
    expect(r.restored).toBe(false);
    expect(r.message).toMatch(/No backup/);
  });
});

// ── hasBackupFor ───────────────────────────────────────────────────────────────

describe('hasBackupFor', () => {
  beforeEach(() => {
    fs.mkdirSync(continueDir(), { recursive: true });
    clean(yamlConfig());
  });

  it('returns false when no backup exists', () => {
    expect(hasBackupFor('continue', TMP)).toBe(false);
  });

  it('returns true after a write creates a backup', () => {
    fs.writeFileSync(yamlConfig(), yaml.dump({ models: [] }));
    writeContinueConfig(BASE_URL, API_KEY, TMP);
    expect(hasBackupFor('continue', TMP)).toBe(true);
  });
});

// ── Aider ──────────────────────────────────────────────────────────────────────

describe('writeAiderConfig', () => {
  beforeEach(() => { clean(aiderConfig()); });

  it('creates .aider.conf.yml when none exists', () => {
    const r = writeAiderConfig(BASE_URL, API_KEY, TMP);
    expect(r.success).toBe(true);
    const content = fs.readFileSync(aiderConfig(), 'utf8');
    expect(content).toContain(`openai-api-base: ${BASE_URL}`);
    expect(content).toContain(`openai-api-key: ${API_KEY}`);
    expect(content).toContain('model: openai/badgr-auto');
  });

  it('appends to existing .aider.conf.yml', () => {
    fs.writeFileSync(aiderConfig(), '# existing aider config\nsome-other-key: true\n');
    const r = writeAiderConfig(BASE_URL, API_KEY, TMP);
    expect(r.success).toBe(true);
    const content = fs.readFileSync(aiderConfig(), 'utf8');
    expect(content).toContain('existing aider config');
    expect(content).toContain(`openai-api-base: ${BASE_URL}`);
  });

  it('creates a backup before modifying', () => {
    fs.writeFileSync(aiderConfig(), 'model: gpt-4\n');
    const r = writeAiderConfig(BASE_URL, API_KEY, TMP);
    expect(r.backupPath).toBeDefined();
    expect(fs.existsSync(r.backupPath!)).toBe(true);
  });

  it('is idempotent', () => {
    writeAiderConfig(BASE_URL, API_KEY, TMP);
    clean(backupPathFor(aiderConfig()));
    const r2 = writeAiderConfig(BASE_URL, API_KEY, TMP);
    expect(r2.success).toBe(true);
    expect(r2.message).toMatch(/already configured/i);
  });

  it('restores on restore call', () => {
    const original = '# original\n';
    fs.writeFileSync(aiderConfig(), original);
    writeAiderConfig(BASE_URL, API_KEY, TMP);

    const r = restoreConfig('aider', TMP);
    expect(r.restored).toBe(true);
    expect(fs.readFileSync(aiderConfig(), 'utf8')).toBe(original);
  });
});

// ── Copilot BYOK ───────────────────────────────────────────────────────────────

function copilotCodeDir(): string {
  if (process.platform === 'darwin') {
    return path.join(TMP, 'Library', 'Application Support', 'Code', 'User');
  }
  return path.join(TMP, '.config', 'Code', 'User');
}

describe('writeCopilotConfig', () => {
  it('writes chatLanguageModels.json to a writable path', () => {
    const codeDir = copilotCodeDir();
    fs.mkdirSync(codeDir, { recursive: true });

    const r = writeCopilotConfig(COMPLETIONS_URL, API_KEY, TMP);
    expect(r.success).toBe(true);

    const modelsFile = path.join(codeDir, 'chatLanguageModels.json');
    expect(fs.existsSync(modelsFile)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(modelsFile, 'utf8'));
    expect(cfg.models.some((m: { url?: string }) => m.url === COMPLETIONS_URL)).toBe(true);
  });

  it('is idempotent', () => {
    fs.mkdirSync(copilotCodeDir(), { recursive: true });
    writeCopilotConfig(COMPLETIONS_URL, API_KEY, TMP);
    const r2 = writeCopilotConfig(COMPLETIONS_URL, API_KEY, TMP);
    expect(r2.success).toBe(true);
    expect(r2.message).toMatch(/already configured/i);
  });
});

// ── cleanup ────────────────────────────────────────────────────────────────────

afterEach(() => {
  for (const f of [yamlConfig(), jsonConfig(), aiderConfig()]) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
    try { fs.unlinkSync(backupPathFor(f)); } catch { /* ignore */ }
  }
});
