/**
 * Tests for the guided `badgr-auto start` wizard configuration.
 *
 * Verifies the exported constants that drive the wizard:
 *   - OUTCOME_CHOICES: exactly two choices (token-only, everything)
 *   - ROUTING_CHOICES: kept for backward compat
 *   - ROUTING_DEFAULT: hybrid
 *   - LOCAL_SERVER_URLS: correct Ollama and LM Studio endpoints
 *   - ONBOARDING_PROMPTS: correct prompt text for each test step
 *
 * No real Ollama, GPU, or network required.
 */

import { describe, it, expect } from 'vitest';
import {
  OUTCOME_CHOICES,
  OUTCOME_MAP,
  ROUTING_CHOICES,
  ROUTING_DEFAULT,
  LOCAL_SERVER_URLS,
  ONBOARDING_PROMPTS,
  parseArgs,
  buildWizardProxyUpdates,
} from '../src/commands/start.js';

// ── Outcome choices ───────────────────────────────────────────────────────

describe('OUTCOME_CHOICES', () => {
  it('has exactly two options', () => {
    expect(OUTCOME_CHOICES).toHaveLength(2);
  });

  it('first choice is token-only', () => {
    expect(OUTCOME_CHOICES[0].value).toBe('token-only');
    expect(OUTCOME_CHOICES[0].short).toContain('Token optimization only');
  });

  it('second choice is everything', () => {
    expect(OUTCOME_CHOICES[1].value).toBe('everything');
    expect(OUTCOME_CHOICES[1].short).toContain('Everything');
  });

  it('token-only choice is Recommended', () => {
    expect(OUTCOME_CHOICES[0].name).toContain('Recommended');
  });

  it('token-only choice mentions keeping current models', () => {
    expect(OUTCOME_CHOICES[0].name.toLowerCase()).toContain('current model');
  });

  it('everything choice mentions routing', () => {
    expect(OUTCOME_CHOICES[1].name.toLowerCase()).toContain('routing');
  });

  it('everything choice mentions local models', () => {
    expect(OUTCOME_CHOICES[1].name.toLowerCase()).toContain('local model');
  });
});

// ── Routing choices (backward compat) ────────────────────────────────────

describe('ROUTING_CHOICES', () => {
  it('has exactly three options', () => {
    expect(ROUTING_CHOICES).toHaveLength(3);
  });

  it('first choice is Local only', () => {
    expect(ROUTING_CHOICES[0].value).toBe('local');
    expect(ROUTING_CHOICES[0].short).toContain('Local only');
  });

  it('second choice is Local + cloud', () => {
    expect(ROUTING_CHOICES[1].value).toBe('hybrid');
    expect(ROUTING_CHOICES[1].short).toContain('Local + cloud');
  });

  it('third choice is Direct (routing off)', () => {
    expect(ROUTING_CHOICES[2].value).toBe('direct');
    expect(ROUTING_CHOICES[2].short.toLowerCase()).toContain('direct');
  });

  it('Direct choice describes routing being disabled', () => {
    expect(ROUTING_CHOICES[2].name.toLowerCase()).toContain('routing off');
  });

  it('Local + cloud choice mentions Recommended', () => {
    expect(ROUTING_CHOICES[1].name).toContain('Recommended');
  });

  it('Local + cloud choice mentions cloud escalation', () => {
    expect(ROUTING_CHOICES[1].name.toLowerCase()).toContain('escalate');
  });

  it('Local only choice mentions no AI Badgr account required', () => {
    expect(ROUTING_CHOICES[0].name.toLowerCase()).toContain('no ai badgr account');
  });
});

// ── Default selection ─────────────────────────────────────────────────────

describe('ROUTING_DEFAULT', () => {
  it('default is hybrid (Local + cloud)', () => {
    expect(ROUTING_DEFAULT).toBe('hybrid');
  });
});

// ── Local server URLs ─────────────────────────────────────────────────────

describe('LOCAL_SERVER_URLS', () => {
  it('Ollama URL is localhost:11434', () => {
    expect(LOCAL_SERVER_URLS.ollama).toBe('http://localhost:11434');
  });

  it('LM Studio URL is localhost:1234', () => {
    expect(LOCAL_SERVER_URLS.lmstudio).toBe('http://localhost:1234');
  });
});

// ── Onboarding prompts ────────────────────────────────────────────────────

describe('ONBOARDING_PROMPTS', () => {
  it('local test prompt is about explaining a JavaScript function', () => {
    expect(ONBOARDING_PROMPTS.local.toLowerCase()).toContain('javascript function');
  });

  it('cloud escalation prompt is about backend architecture security review', () => {
    expect(ONBOARDING_PROMPTS.cloud.toLowerCase()).toContain('backend architecture');
    expect(ONBOARDING_PROMPTS.cloud.toLowerCase()).toContain('security');
  });
});

describe('setupCommand', () => {
  it('is exported from start.js', async () => {
    const mod = await import('../src/commands/start.js');
    expect(typeof mod.setupCommand).toBe('function');
  });
});

describe('buildWizardProxyUpdates', () => {
  for (const [outcome, settings] of Object.entries(OUTCOME_MAP)) {
    it(`${outcome} includes savingsStats (regression: savingsStats is not defined)`, () => {
      const updates = buildWizardProxyUpdates(settings, {}, {
        freshConfig: { baseUrl: 'https://aibadgr.com/v1' },
      });
      expect(updates.savingsStats).toBe(true);
      expect(updates.tokenOptimization).toBe(settings.tokenOptimization);
      expect(updates.routingMode).toBe(settings.routingMode);
      expect(updates.upstreamBaseUrl).toBe('https://aibadgr.com/v1');
    });
  }

  it('adds local edge config when a server is detected', () => {
    const updates = buildWizardProxyUpdates(OUTCOME_MAP.everything, {}, {
      localBaseUrl: 'http://localhost:11434/v1',
      localModel: 'qwen2.5-coder:7b',
    });
    expect(updates.edgeBaseUrl).toBe('http://localhost:11434/v1');
    expect(updates.edgeModel).toBe('qwen2.5-coder:7b');
    expect(updates.savingsStats).toBe(true);
  });
});

describe('ROUTING_CHOICES menu options', () => {
  it('contains all three routing values', () => {
    const values = ROUTING_CHOICES.map(c => c.value);
    expect(values).toContain('local');
    expect(values).toContain('hybrid');
    expect(values).toContain('direct');
  });
});

describe('parseArgs — CLI flags', () => {
  it('--no-route sets routingMode to direct', () => {
    const result = parseArgs(['--no-route']);
    expect(result.routingMode).toBe('direct');
  });

  it('--no-optimize sets tokenOptimization to false', () => {
    const result = parseArgs(['--no-optimize']);
    expect(result.tokenOptimization).toBe(false);
  });

  it('--no-route and --no-optimize can be combined', () => {
    const result = parseArgs(['--no-route', '--no-optimize']);
    expect(result.routingMode).toBe('direct');
    expect(result.tokenOptimization).toBe(false);
  });

  it('--upstream still sets upstreamBaseUrl', () => {
    const result = parseArgs(['--upstream', 'https://example.com/v1']);
    expect(result.upstreamBaseUrl).toBe('https://example.com/v1');
  });

  it('--setup sets forceWizard', () => {
    const result = parseArgs(['--setup']);
    expect(result.forceWizard).toBe(true);
  });

  it('unknown flags are ignored without error', () => {
    const result = parseArgs(['--unknown-flag', '--no-route']);
    expect(result.routingMode).toBe('direct');
  });
});
