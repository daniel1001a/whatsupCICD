/**
 * 佇列重試的指數退避 + 抖動（jitter）。
 *
 * 純函式：時間與亂數來源全部由呼叫端注入，方便 `Worker` 與測試用固定
 * 輸入得到決定性結果。
 *
 * SPEC.md 沒有為「事件佇列重試」訂出具體數字（§7.4「重試 1 次」講的是
 * LLM 呼叫本身，是完全不同的一層），因此 `DEFAULT_RETRY_POLICY` 是本任務
 * （P1-06）自訂的合理預設值：5 次嘗試機會、初始 1 秒、封頂 5 分鐘、倍率 2。
 * 日後要調整重試策略只需要改這裡，不需要動 `Worker` 的邏輯。
 */
import type { RetryPolicy } from '../types/events.js';

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  initialDelayMs: 1_000,
  maxDelayMs: 5 * 60_000, // 5 分鐘
  backoffMultiplier: 2,
};

export interface BackoffOptions {
  readonly policy?: RetryPolicy;
  /** 亂數來源，預設 `Math.random`。測試注入固定值以得到決定性結果。 */
  readonly random?: () => number;
}

/**
 * 算出第 `attempts` 次失敗後，下一次重試前要等待的毫秒數。
 *
 * `attempts` 是「已經失敗的次數」（從 1 起算）：一筆事件第 1 次失敗後呼叫
 * `computeBackoffMs(1, ...)`，算出的是第 2 次嘗試前的等待時間。
 *
 * 演算法是 AWS 那篇經典文章建議的 **full jitter**：
 *   1. `exponential = initialDelayMs * backoffMultiplier ^ (attempts - 1)`
 *   2. `base = min(maxDelayMs, exponential)`——封頂，避免無界增長
 *   3. 最終延遲是 `[0, base]` 之間均勻分布的隨機值
 *
 * 比起「base ± 固定百分比」的做法，full jitter 能更有效打散多個事件
 * 同時重試造成的驚群效應（thundering herd）——這裡的情境是：一次外部
 * 依賴（例如 GitHub API 或 Slack）短暫中斷，會讓一批事件在同一時刻
 * 失敗，若退避時間彼此接近，重試會再次同時打進去。
 */
export function computeBackoffMs(attempts: number, options: BackoffOptions = {}): number {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error(`attempts 必須是 >= 1 的整數，收到：${String(attempts)}`);
  }

  const policy = options.policy ?? DEFAULT_RETRY_POLICY;
  const random = options.random ?? Math.random;

  const exponential = policy.initialDelayMs * policy.backoffMultiplier ** (attempts - 1);
  const base = Math.min(policy.maxDelayMs, exponential);

  return Math.floor(random() * base);
}
