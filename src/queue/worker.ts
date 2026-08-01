/**
 * `events` 表驅動的 in-process worker（P1-06）。
 *
 * 設計原則：
 *   - 只依賴 `EventRepository`、注入的 `EventHandler`、與一個可注入的
 *     `now()` 時鐘——不直接呼叫 `Date.now()` / `new Date()`，測試才能用
 *     固定時間決定性地驗證 backoff / 孤兒回收 / 死信化，不必依賴假計時器。
 *   - 這裡完全不知道「處理一個事件」實際上要做什麼（抓 log、sanitize、
 *     呼叫 LLM、投遞 Slack）。那是 Phase 2/3 的事，見下面的 `EventHandler`
 *     介面——真正的管線會實作它並在 `main.ts` 注入，這裡只負責佇列生命
 *     週期（claim → 交給 handler → 依結果轉移狀態）。
 *   - `stop()` 是「基本優雅停止」：不再 claim 新工作、等目前這一筆（若有）
 *     做完。完整的 SIGTERM 收斂（等 HTTP 連線、逾時強制關閉）是 `P4-03`，
 *     這裡不做，`main.ts` 目前也還沒有接上這個 `Worker`（見 `src/main.ts`
 *     開頭的註解——`main.ts` 的優雅關閉目前只涵蓋 HTTP 層）。
 */
import type { EventRepository } from '../db/repositories.js';
import type { EventRow } from '../types/db.js';
import type { RetryPolicy } from '../types/events.js';
import { computeBackoffMs, DEFAULT_RETRY_POLICY } from './backoff.js';
import { summarizeError } from './errors.js';

/**
 * 真正的處理管線（抓 log → sanitize → 擷取錯誤區段 → LLM → 渲染迷因卡 →
 * 投遞 Slack）由 Phase 2/3 實作並注入，這裡只定義介面。
 *
 * 契約：
 *   - 收到一筆已被 `claimNext` 標成 `processing` 的 `EventRow`。
 *   - 回傳 `'done'`：處理完成（不論最終是否走了 R4 的模板 fallback——
 *     那是管線內部的事，對佇列來說只要沒拋例外就是「處理完了」）。
 *   - 回傳 `'skip'`：這筆事件不需要處理（例如 `conclusion !== 'failure'`），
 *     佇列會標成 `skipped` 而不是 `done`，方便日後統計區分兩者。
 *   - 拋出例外：視為失敗，`Worker` 接住並依 retry policy 決定重試或死信。
 *     handler 不該自己碰 `events` 表——狀態轉移一律由 `Worker` 負責，
 *     這樣重試/死信的邏輯只有一處，不會因為多個 handler 各自實作而分岔。
 */
export interface EventHandler {
  handle(event: EventRow): Promise<EventHandlerResult> | EventHandlerResult;
}

export type EventHandlerResult = 'done' | 'skip';

export interface WorkerOptions {
  readonly eventRepo: EventRepository;
  readonly handler: EventHandler;
  /** 決定性時鐘。預設 `() => new Date().toISOString()`。 */
  readonly now?: () => string;
  readonly retryPolicy?: RetryPolicy;
  /** 孤兒回收門檻（毫秒）：`claimed_at` 早於「現在 − 此值」的 `processing`
   * 事件視為孤兒（程序上次被 SIGKILL，沒能走到 markDone/markFailed/markDead）。 */
  readonly orphanThresholdMs?: number;
  /** `claimNext` 沒撿到事件時，下一輪之前等待的毫秒數。 */
  readonly pollIntervalMs?: number;
  /** backoff 的亂數來源；測試注入固定值以得到決定性結果。見 `backoff.ts`。 */
  readonly random?: () => number;
}

const DEFAULT_ORPHAN_THRESHOLD_MS = 10 * 60_000; // 10 分鐘
const DEFAULT_POLL_INTERVAL_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class Worker {
  private readonly eventRepo: EventRepository;
  private readonly handler: EventHandler;
  private readonly now: () => string;
  private readonly retryPolicy: RetryPolicy;
  private readonly orphanThresholdMs: number;
  private readonly pollIntervalMs: number;
  private readonly random: (() => number) | undefined;

  private running = false;
  private loopPromise: Promise<void> | undefined;
  /** 目前正在跑的一筆處理。`stop()` 要等它做完才算乾淨收斂——
   * 不留下卡在 `processing` 的孤兒。 */
  private inFlight: Promise<'processed' | 'idle'> | undefined;

  constructor(options: WorkerOptions) {
    this.eventRepo = options.eventRepo;
    this.handler = options.handler;
    this.now = options.now ?? (() => new Date().toISOString());
    this.retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.orphanThresholdMs = options.orphanThresholdMs ?? DEFAULT_ORPHAN_THRESHOLD_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.random = options.random;
  }

  /**
   * 回收孤兒（見類別註解），然後開始輪詢迴圈。
   *
   * @returns 這次開機回收了幾筆孤兒事件（供啟動時記錄用）。
   */
  start(): number {
    const reclaimed = this.reclaimOrphans();
    this.running = true;
    this.loopPromise = this.loop();
    return reclaimed;
  }

  /** 停止 claim 新工作，並等目前這一筆（若有）做完。 */
  async stop(): Promise<void> {
    this.running = false;
    await this.inFlight;
    await this.loopPromise;
  }

  /**
   * 嘗試 claim 並處理一筆事件；沒有可處理的事件時回傳 `'idle'`。
   *
   * 獨立於 `start()`/`stop()` 的輪詢迴圈之外公開，是刻意的設計：測試
   * 不必依賴假計時器或真的等待 `pollIntervalMs`，可以逐筆決定性地驅動
   * 「claim → 失敗 → 退避 → 再失敗 → … → 死信」這種跨多次呼叫的流程。
   * `loop()` 內部也是靠重複呼叫這個方法實作的，行為與正式跑起來一致。
   */
  async runOnce(): Promise<'processed' | 'idle'> {
    const claimed = this.eventRepo.claimNext(this.now());
    if (claimed === undefined) return 'idle';
    await this.processOne(claimed);
    return 'processed';
  }

  private reclaimOrphans(): number {
    const threshold = new Date(
      new Date(this.now()).getTime() - this.orphanThresholdMs,
    ).toISOString();
    return this.eventRepo.reclaimOrphans(threshold);
  }

  /**
   * 讀 `this.running` 的目前值。刻意包成方法而不是直接讀屬性——
   * `loop()` 裡在 `await` 之後會再檢查一次，TypeScript 的窄化分析看不到
   * `stop()` 可能在那個 await 期間於別的呼叫堆疊上把它改成 `false`，
   * 直接讀屬性會被 `@typescript-eslint/no-unnecessary-condition` 誤判成
   * 恆真。包成方法呼叫讓 TS 把回傳值當成一般 `boolean`，讀到的仍是
   * 當下的真實值，行為不變，只是不再觸發這個型別層的假警報。
   */
  private isRunning(): boolean {
    return this.running;
  }

  private async loop(): Promise<void> {
    while (this.isRunning()) {
      const task = this.runOnce();
      this.inFlight = task;
      const outcome = await task;
      this.inFlight = undefined;

      if (outcome === 'idle' && this.isRunning()) {
        await sleep(this.pollIntervalMs);
      }
    }
  }

  private async processOne(event: EventRow): Promise<void> {
    try {
      const result = await this.handler.handle(event);
      if (result === 'skip') {
        this.eventRepo.markSkipped(event.id, this.now());
      } else {
        this.eventRepo.markDone(event.id, this.now());
      }
    } catch (err) {
      this.handleFailure(event, err);
    }
  }

  /** R4：失敗絕不靜默——不論是重試還是死信，都會落一筆遮罩後的錯誤
   * 摘要在 `events.last_error`（見 `errors.ts`）。 */
  private handleFailure(event: EventRow, err: unknown): void {
    const summary = summarizeError(err);
    // `event.attempts` 是「claim 這筆之前已經失敗過幾次」；這次若也失敗，
    // 失敗總次數就是 `attempts + 1`，用它來判斷是否達到死信門檻。
    const attemptsAfterThisFailure = event.attempts + 1;

    if (attemptsAfterThisFailure >= this.retryPolicy.maxAttempts) {
      this.eventRepo.markDead(event.id, summary, this.now());
      return;
    }

    const delayMs = computeBackoffMs(attemptsAfterThisFailure, {
      policy: this.retryPolicy,
      ...(this.random ? { random: this.random } : {}),
    });
    const nextAttemptAt = new Date(new Date(this.now()).getTime() + delayMs).toISOString();
    this.eventRepo.markFailed(event.id, summary, nextAttemptAt);
  }
}
