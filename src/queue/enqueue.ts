/**
 * webhook → `events` 表的落庫實作。滿足 `src/routes/webhook.ts` 的
 * `WebhookDeps['enqueue']` 契約——webhook handler 驗簽後立刻呼叫這裡，
 * R3 的 3 秒預算之內只做一件事：判斷是否要處理、算 digest、去重、落庫。
 *
 * ★ R2：只把 `EventRepository.insertPending` 需要的 `rawBody` 往下傳一層，
 * 該方法內部算完 SHA-256 digest 後就不再引用它（見 `repositories.ts` 開頭
 * 的說明）。
 *
 * ⚠️ 2026-08-01 更新（P1-09 redteam RT1-01 修補，見
 * `docs/redteam/P1-09-webhook-replay.md`）：這個檔案原本完全不讀 `rawBody`
 * 的內容，`installationId`/`repoFullName`/`runId`/`runUpdatedAt` 全部固定傳
 * `null`——這使得 THREAT_MODEL.md §5.2 的層 2（業務層冪等鍵）與層 3（新鮮度
 * 視窗）從未真正運作，唯一在跑的只有層 1（delivery_id，文件明說「這一層的
 * 主要目的是冪等性而非安全」）。攻擊者只要側錄過一次合法的 `(body, 簽章)`，
 * 就能用偽造的 `X-GitHub-Delivery` 無限次重放。
 *
 * 現在對 `workflow_run` 事件會 `JSON.parse(rawBody)` 一次以取出
 * `workflow_run.id` / `run_attempt` / `updated_at`——這仍然只是**讀取**，
 * 不違反 R2（R2 禁止的是落地儲存與記錄，不是記憶體中暫時解析）；解析結果
 * 只有三個純量值會被傳給 `insertPending`，`rawBody` 本體與其餘欄位一樣
 * 不會被存入任何 SQL 參數。<1MB payload 的 `JSON.parse` 是次毫秒級操作，
 * 不會實質侵蝕 R3 的 3 秒預算。
 *
 * `installationId`/`repoFullName` 仍固定傳 `null`：把 GitHub 的數字
 * installation id 轉成我方的 `installations.id`（ULID）需要一次額外的
 * repository 查詢，且不是任何一個 redteam 發現要求的修補範圍，留給 worker
 * 在 Phase 2 解析完整 payload 時回填（`migrations/0001_init.sql` 的
 * 既有設計）。
 */
import type { EventRepository } from '../db/repositories.js';
import { GITHUB_EVENT_TYPES, type GitHubEventType } from '../types/events.js';
import type { EnqueueOutcome, IncomingEvent } from '../routes/webhook.js';

/** THREAT_MODEL.md §5.2 層 3：拒絕早於這個視窗的 workflow_run 事件。 */
const FRESHNESS_WINDOW_MS = 15 * 60 * 1000;

function isGitHubEventType(value: string): value is GitHubEventType {
  return (GITHUB_EVENT_TYPES as readonly string[]).includes(value);
}

interface WorkflowRunKey {
  readonly runId: number;
  readonly runAttempt: number;
  readonly updatedAt: string;
}

/**
 * 盡力而為地從 `workflow_run` payload 取出冪等鍵所需欄位。刻意寬鬆：
 * 解析失敗（畸形 JSON、欄位缺漏或型別不符）回傳 `null`，呼叫端會退化成
 * 只有層 1（delivery_id）保護——**不會**因為一次無法預期的解析失敗而拒收
 * 一個已通過簽章驗證的合法事件（R4：不能因為防禦層的 bug 犧牲可用性）。
 * 這不是完整的 schema 驗證（那是 Phase 2 worker 解析完整 payload 時的職責），
 * 只取三個純量值。
 */
function extractWorkflowRunKey(rawBody: Buffer): WorkflowRunKey | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || !('workflow_run' in parsed)) {
    return null;
  }
  const workflowRun = parsed.workflow_run;
  if (
    typeof workflowRun !== 'object' ||
    workflowRun === null ||
    !('id' in workflowRun) ||
    !('run_attempt' in workflowRun) ||
    !('updated_at' in workflowRun)
  ) {
    return null;
  }

  const { id, run_attempt: runAttempt, updated_at: updatedAt } = workflowRun;
  if (
    typeof id !== 'number' ||
    typeof runAttempt !== 'number' ||
    typeof updatedAt !== 'string' ||
    Number.isNaN(Date.parse(updatedAt))
  ) {
    return null;
  }

  return { runId: id, runAttempt, updatedAt };
}

function isStale(updatedAt: string, now: Date): boolean {
  return Date.parse(updatedAt) < now.getTime() - FRESHNESS_WINDOW_MS;
}

export interface CreateEnqueueOptions {
  /** 供測試注入固定時鐘；預設 `() => new Date()`。 */
  readonly now?: () => Date;
}

/**
 * 建立 `enqueue` 函式，綁定一個 `EventRepository`。
 *
 * @returns 回傳值直接對應 `EnqueueOutcome`：
 *   - `'accepted'` — 新事件已落庫
 *   - `'duplicate'` — `delivery_id`（層 1）或 `(run_id, run_attempt)`（層 2）已存在
 *   - `'stale'` — `workflow_run.updated_at` 早於 15 分鐘新鮮度視窗（層 3）
 *   - `'skipped'` — 已驗簽、有訂閱，但不是我們會實際處理的事件類型
 *   - `'unavailable'` — DB layer 出狀況；讓 `webhook.ts` 回 503，GitHub 重送
 */
export function createEnqueue(
  eventRepo: EventRepository,
  { now = () => new Date() }: CreateEnqueueOptions = {},
): (event: IncomingEvent) => EnqueueOutcome {
  return (event: IncomingEvent): EnqueueOutcome => {
    // `webhook.ts` 的 SUBSCRIBED_EVENTS 過濾只看標頭是否「有訂閱」；
    // 是否屬於我們真正會處理的 `GitHubEventType` 集合，由這裡再判一次。
    if (!isGitHubEventType(event.eventType)) {
      return 'skipped';
    }

    const workflowRunKey =
      event.eventType === 'workflow_run' ? extractWorkflowRunKey(event.rawBody) : null;

    if (workflowRunKey !== null && isStale(workflowRunKey.updatedAt, now())) {
      return 'stale';
    }

    try {
      // `insertPending` 回傳 'accepted' | 'duplicate'，剛好是 EnqueueOutcome
      // 的子集，可以直接回傳。
      return eventRepo.insertPending({
        deliveryId: event.deliveryId,
        installationId: null,
        eventType: event.eventType,
        repoFullName: null,
        runId: workflowRunKey?.runId ?? null,
        runAttempt: workflowRunKey?.runAttempt ?? null,
        runUpdatedAt: workflowRunKey?.updatedAt ?? null,
        receivedAt: event.receivedAt,
        rawBody: event.rawBody,
      });
    } catch {
      // R4：DB layer 出狀況不能吞掉不回應。刻意不重新拋出——回傳
      // 'unavailable' 讓 `webhook.ts` 走它既有的 503 分支，呼叫端不必
      // 額外包一層 try/catch 也能處理，介面更乾淨（`webhook.ts` 對
      // enqueue 拋例外的情況一樣有處理，兩條路徑殊途同歸）。
      return 'unavailable';
    }
  };
}
