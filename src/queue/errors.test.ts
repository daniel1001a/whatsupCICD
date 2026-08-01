import { describe, expect, it } from 'vitest';

import { summarizeError } from './errors.js';

describe('summarizeError', () => {
  it('Error 只取 name/message，不含 stack', () => {
    const err = new Error('LLM 逾時');
    const summary = summarizeError(err);
    expect(summary).toBe('Error: LLM 逾時');
    expect(summary).not.toContain('at ');
    expect(err.stack).toBeDefined();
    expect(summary).not.toContain(err.stack ?? '__unreachable__');
  });

  it('自訂 Error 子類別保留 name', () => {
    class TimeoutError extends Error {
      override readonly name = 'TimeoutError';
    }
    expect(summarizeError(new TimeoutError('逾時'))).toBe('TimeoutError: 逾時');
  });

  it('非 Error 拋出值一律轉字串，不遍歷屬性', () => {
    expect(summarizeError('plain string')).toBe('plain string');
    expect(summarizeError(42)).toBe('42');
  });

  it('多行內容攤平成單行', () => {
    const err = new Error('第一行\n第二行\n\n第三行');
    expect(summarizeError(err)).toBe('Error: 第一行 第二行 第三行');
    expect(summarizeError(err)).not.toContain('\n');
  });

  it('過長內容被截斷並補上刪節號', () => {
    const err = new Error('x'.repeat(1000));
    const summary = summarizeError(err);
    expect(summary.length).toBeLessThanOrEqual(501);
    expect(summary.endsWith('…')).toBe(true);
  });
});
