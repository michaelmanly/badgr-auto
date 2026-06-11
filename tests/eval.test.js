import { describe, it, expect } from 'vitest';
import { sameToolCalls, noMissingContextComplaint, similarEnough } from '../src/eval-runner.js';

// ── sameToolCalls ────────────────────────────────────────────────────────────

describe('sameToolCalls', () => {
  const resp = (toolCalls) => ({ data: { choices: [{ message: { tool_calls: toolCalls } }] } });
  const noTools = { data: { choices: [{ message: {} }] } };

  it('returns true when both responses have no tool calls', () => {
    expect(sameToolCalls(noTools, noTools)).toBe(true);
  });

  it('returns true when tool call names and args match', () => {
    const tc = [{ function: { name: 'readFile', arguments: '{"path":"a.js"}' } }];
    expect(sameToolCalls(resp(tc), resp(tc))).toBe(true);
  });

  it('returns false when one has tool calls and the other does not', () => {
    const tc = [{ function: { name: 'readFile', arguments: '{}' } }];
    expect(sameToolCalls(resp(tc), noTools)).toBe(false);
  });

  it('returns false when tool call names differ', () => {
    const a = resp([{ function: { name: 'readFile',  arguments: '{}' } }]);
    const b = resp([{ function: { name: 'writeFile', arguments: '{}' } }]);
    expect(sameToolCalls(a, b)).toBe(false);
  });

  it('returns false when tool call args differ', () => {
    const a = resp([{ function: { name: 'readFile', arguments: '{"path":"a.js"}' } }]);
    const b = resp([{ function: { name: 'readFile', arguments: '{"path":"b.js"}' } }]);
    expect(sameToolCalls(a, b)).toBe(false);
  });

  it('returns false when call count differs', () => {
    const tc = [{ function: { name: 'readFile', arguments: '{}' } }];
    expect(sameToolCalls(resp(tc), resp([...tc, ...tc]))).toBe(false);
  });

  it('handles missing/null responses gracefully', () => {
    expect(sameToolCalls(null, null)).toBe(true);
    expect(sameToolCalls({}, {})).toBe(true);
  });
});

// ── noMissingContextComplaint ────────────────────────────────────────────────

describe('noMissingContextComplaint', () => {
  it('returns true for normal refactor output', () => {
    expect(noMissingContextComplaint('Here is the refactored version of your function.')).toBe(true);
  });

  it('returns true for empty string', () => {
    expect(noMissingContextComplaint('')).toBe(true);
  });

  it('returns true for null/undefined', () => {
    expect(noMissingContextComplaint(null)).toBe(true);
    expect(noMissingContextComplaint(undefined)).toBe(true);
  });

  it('returns false when output says "missing context"', () => {
    expect(noMissingContextComplaint("I'm sorry, but there's missing context from the previous turn.")).toBe(false);
  });

  it('returns false when output says "don\'t have the context"', () => {
    expect(noMissingContextComplaint("I don't have the context needed to answer this.")).toBe(false);
  });

  it('returns false when output says "not provided"', () => {
    expect(noMissingContextComplaint('The file contents were not provided.')).toBe(false);
  });

  it('returns false when output says "please provide"', () => {
    expect(noMissingContextComplaint('Please provide the source code so I can help.')).toBe(false);
  });

  it('returns false when output says "context was removed"', () => {
    expect(noMissingContextComplaint('It seems the context was removed from this conversation.')).toBe(false);
  });

  it('returns true for output that mentions context in a neutral way', () => {
    expect(noMissingContextComplaint('The context window for this model is 128k tokens.')).toBe(true);
  });
});

// ── similarEnough ────────────────────────────────────────────────────────────

describe('similarEnough', () => {
  it('returns true for identical strings', () => {
    expect(similarEnough('hello world', 'hello world')).toBe(true);
  });

  it('returns true when strings are within default 50% threshold', () => {
    expect(similarEnough('abcdef', 'abcdefghijk')).toBe(true); // 6/11 ≈ 55%
  });

  it('returns false when one string is much shorter than the other', () => {
    expect(similarEnough('ab', 'a'.repeat(100))).toBe(false); // 2%
  });

  it('returns true for both empty strings', () => {
    expect(similarEnough('', '')).toBe(true);
  });

  it('returns false when one is empty and the other is not', () => {
    expect(similarEnough('', 'some text')).toBe(false);
    expect(similarEnough('some text', '')).toBe(false);
  });

  it('respects a custom threshold', () => {
    expect(similarEnough('abc', 'abcde', 0.8)).toBe(false); // 3/5 = 60% < 80%
    expect(similarEnough('abc', 'abcd',  0.7)).toBe(true);  // 3/4 = 75% > 70%
  });
});
