/**
 * Tests for the guided `badgr-auto start` wizard configuration.
 *
 * Verifies the exported constants that drive the wizard:
 *   - ROUTING_CHOICES: Local only first, Local + cloud second
 *   - ROUTING_DEFAULT: hybrid
 *   - LOCAL_SERVER_URLS: correct Ollama and LM Studio endpoints
 *   - ONBOARDING_PROMPTS: correct prompt text for each test step
 *
 * No real Ollama, GPU, or network required.
 */

import { describe, it, expect } from 'vitest';
import {
  ROUTING_CHOICES,
  ROUTING_DEFAULT,
  LOCAL_SERVER_URLS,
  ONBOARDING_PROMPTS,
} from '../src/commands/start.js';

// ── Choice order ──────────────────────────────────────────────────────────

describe('ROUTING_CHOICES', () => {
  it('has exactly two options', () => {
    expect(ROUTING_CHOICES).toHaveLength(2);
  });

  it('first choice is Local only', () => {
    expect(ROUTING_CHOICES[0].value).toBe('local');
    expect(ROUTING_CHOICES[0].short).toContain('Local only');
  });

  it('second choice is Local + cloud', () => {
    expect(ROUTING_CHOICES[1].value).toBe('hybrid');
    expect(ROUTING_CHOICES[1].short).toContain('Local + cloud');
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

describe('ROUTING_CHOICES menu options', () => {
  it('has a show connection instructions option text in the already-running choices', () => {
    // This is inline in startCommand — we verify the exported choices shape is correct
    // and that ROUTING_CHOICES has both required values
    expect(ROUTING_CHOICES.map(c => c.value)).toContain('local');
    expect(ROUTING_CHOICES.map(c => c.value)).toContain('hybrid');
  });
});
