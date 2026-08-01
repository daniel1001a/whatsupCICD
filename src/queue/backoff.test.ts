import { describe, expect, it } from 'vitest';

import { computeBackoffMs, DEFAULT_RETRY_POLICY } from './backoff.js';
import type { RetryPolicy } from '../types/events.js';

const POLICY: RetryPolicy = {
  maxAttempts: 5,
  initialDelayMs: 1_000,
  maxDelayMs: 10_000,
  backoffMultiplier: 2,
};

describe('computeBackoffMs', () => {
  it('指數成長：base 隨 attempts 以 backoffMultiplier 倍增', () => {
    // random 固定回傳 1，讓結果等於未夾制前的 base（浮點誤差用 Math.floor 已處理）。
    const random = () => 1;

    expect(computeBackoffMs(1, { policy: POLICY, random })).toBe(1_000); // 1000 * 2^0
    expect(computeBackoffMs(2, { policy: POLICY, random })).toBe(2_000); // 1000 * 2^1
    expect(computeBackoffMs(3, { policy: POLICY, random })).toBe(4_000); // 1000 * 2^2
  });

  it('封頂於 maxDelayMs，不會無界增長', () => {
    const random = () => 1;
    // 1000 * 2^9 = 512,000，遠超過 maxDelayMs = 10,000。
    expect(computeBackoffMs(10, { policy: POLICY, random })).toBe(10_000);
  });

  it('full jitter：結果落在 [0, base) 之間', () => {
    const random = () => 0.5;
    // attempts=2 → base = 2000；random 固定 0.5 → 1000
    expect(computeBackoffMs(2, { policy: POLICY, random })).toBe(1_000);
  });

  it('random 回傳 0 時延遲為 0（full jitter 的下界）', () => {
    const random = () => 0;
    expect(computeBackoffMs(3, { policy: POLICY, random })).toBe(0);
  });

  it('沒有指定 policy 時使用 DEFAULT_RETRY_POLICY', () => {
    const random = () => 1;
    expect(computeBackoffMs(1, { random })).toBe(DEFAULT_RETRY_POLICY.initialDelayMs);
  });

  it('沒有指定 random 時使用 Math.random，結果是合法數字', () => {
    const ms = computeBackoffMs(1, { policy: POLICY });
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(ms).toBeLessThan(POLICY.initialDelayMs);
  });

  it('attempts < 1 或非整數會拋錯', () => {
    expect(() => computeBackoffMs(0)).toThrow();
    expect(() => computeBackoffMs(-1)).toThrow();
    expect(() => computeBackoffMs(1.5)).toThrow();
  });
});
