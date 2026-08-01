/**
 * webhook → `events` 表的落庫實作。滿足 `src/routes/webhook.ts` 的
 * `WebhookDeps['enqueue']` 契約——webhook handler 驗簽後立刻呼叫這裡，
 * R3 的 3 秒預算之內只做一件事：判斷是否要處理、算 digest、去重、落庫。
 *
 * ★ R2：只把 `EventRepository.insertPending` 需要的 `rawBody` 往下傳一層，
 * 該方法內部算完 SHA-256 digest 後就不再引用它（見 `repositories.ts` 開頭
 * 的說明）。這個檔案自己完全不讀 `rawBody` 的內容，也不 log 它。
 *
 * `installationId` / `repoFullName` 這裡固定傳 `null`：`IncomingEvent`
 * （`routes/webhook.ts`）只有 headers 裡的 deliveryId / eventType，
 * 不含任何 payload 內容——webhook handler 依 R3 在驗簽後立刻落庫，
 * 當下還沒 parse body，不可能知道 installation 或 repo 是誰。
 * `migrations/0001_init.sql` 對 `events.installation_id` / `repo_full_name`
 * 「可為 NULL」的說明就是為了這個情境；worker 解析 payload 後再回填。
 */
import type { EventRepository } from '../db/repositories.js';
import { GITHUB_EVENT_TYPES, type GitHubEventType } from '../types/events.js';
import type { EnqueueOutcome, IncomingEvent } from '../routes/webhook.js';

function isGitHubEventType(value: string): value is GitHubEventType {
  return (GITHUB_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * 建立 `enqueue` 函式，綁定一個 `EventRepository`。
 *
 * @returns 回傳值直接對應 `EnqueueOutcome`：
 *   - `'accepted'` — 新事件已落庫
 *   - `'duplicate'` — `delivery_id` 已存在（`events` 表的 UNIQUE 約束保證）
 *   - `'skipped'` — 已驗簽、有訂閱（`webhook.ts` 的 `SUBSCRIBED_EVENTS`），
 *     但不是我們會實際處理的事件類型（目前只有 `ping`：GitHub 設定
 *     webhook 時會送一次讓 UI 顯示綠勾，落庫沒有意義）
 *   - `'unavailable'` — DB layer 出狀況；讓 `webhook.ts` 回 503，GitHub 重送
 */
export function createEnqueue(
  eventRepo: EventRepository,
): (event: IncomingEvent) => EnqueueOutcome {
  return (event: IncomingEvent): EnqueueOutcome => {
    // `webhook.ts` 的 SUBSCRIBED_EVENTS 過濾只看標頭是否「有訂閱」；
    // 是否屬於我們真正會處理的 `GitHubEventType` 集合，由這裡再判一次。
    if (!isGitHubEventType(event.eventType)) {
      return 'skipped';
    }

    try {
      // `insertPending` 回傳 'accepted' | 'duplicate'，剛好是 EnqueueOutcome
      // 的子集，可以直接回傳。
      return eventRepo.insertPending({
        deliveryId: event.deliveryId,
        installationId: null,
        eventType: event.eventType,
        repoFullName: null,
        runId: null,
        runUpdatedAt: null,
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
