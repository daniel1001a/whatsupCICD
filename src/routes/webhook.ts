/**
 * GitHub webhook 端點。
 *
 * **R3 即時回應鐵則**：這個 handler 只做四件事——驗簽、去重、落庫、回 200。
 * 目標 < 500ms，硬預算 3 秒。任何需要外部網路往返的工作（抓 log、呼叫 LLM、
 * 投遞 Slack）一律交給 worker，見 `SPEC.md` §4。
 *
 * GitHub 對 webhook 的容忍時間是 10 秒，超時會標記投遞失敗並重送。我們的
 * 管線 P95 約 20–40 秒，同步處理必然逾時 → 重送 → 使用者收到重複判決書。
 *
 * **回應語意**（刻意設計，不是隨手選的）：
 *   200 — 已接受並落庫，或已知的重複投遞，或不需處理的事件
 *   401 — 驗簽失敗。**不區分原因**，錯誤細節只進日誌
 *   503 — 佇列已滿或 DB 不可用。GitHub 會重送，這正是我們要的
 *
 * 注意這裡沒有 4xx-for-bad-payload：格式不對的 payload 一律回 200 並記錄，
 * 因為 GitHub 重送一個我們本來就不會處理的 payload 沒有意義。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { verifyGitHubSignature } from '../security/verify-signature.js';

/** webhook handler 需要的最小依賴。用介面隔離以便測試與日後抽換。 */
export interface WebhookDeps {
  readonly webhookSecret: string;
  /**
   * 落庫並排入佇列。
   *
   * @returns `'accepted'` 新事件已落庫｜`'duplicate'` delivery_id 或
   *          `(run_id, run_attempt)` 已存在（THREAT_MODEL.md §5.2 層 1/2）｜
   *          `'stale'` workflow_run.updated_at 早於新鮮度視窗（同 §5.2 層 3）｜
   *          `'skipped'` 不需處理｜`'unavailable'` 佇列或 DB 暫時不可用
   */
  readonly enqueue: (event: IncomingEvent) => Promise<EnqueueOutcome> | EnqueueOutcome;
}

export type EnqueueOutcome = 'accepted' | 'duplicate' | 'stale' | 'skipped' | 'unavailable';

export interface IncomingEvent {
  readonly deliveryId: string;
  readonly eventType: string;
  /** 已驗簽的 raw body。呼叫端負責 parse——handler 不替它決定結構。 */
  readonly rawBody: Buffer;
  readonly receivedAt: string;
}

/** GitHub 的標頭名稱（小寫，Fastify 會正規化）。 */
const H_SIGNATURE = 'x-hub-signature-256';
const H_DELIVERY = 'x-github-delivery';
const H_EVENT = 'x-github-event';

/**
 * 我們訂閱的事件類型（必須與 `app-manifest.yml` 的 `default_events` 一致）。
 *
 * 這個過濾是**只看標頭、不 parse body** 的——維持 R3 的預算，同時避免
 * 「簽章正確但完全不相關的事件」佔用該 installation 的處理配額
 * （redteam P1-09 #4：那會稀釋掉 per-installation rate limit 的效果）。
 *
 * ⚠️ 這裡**不做** `conclusion == failure` 的過濾——那需要 parse payload，
 * 是 worker 的職責。`SPEC.md` §4 的事件流圖原本把它畫在 ① 步驟內，是圖錯了。
 */
const SUBSCRIBED_EVENTS: ReadonlySet<string> = new Set([
  'workflow_run',
  'installation',
  'installation_repositories',
  // GitHub 在設定 webhook 時會送一次，回 200 讓它的 UI 顯示綠勾。
  'ping',
]);

function headerValue(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers[name];
  if (typeof raw === 'string') return raw;
  // 標頭重複出現時 Fastify 給陣列。重複的簽章標頭是可疑的，不猜測意圖，直接視為缺失。
  return undefined;
}

export function registerWebhookRoutes(app: FastifyInstance, deps: WebhookDeps): void {
  // ── raw body 保留 ──────────────────────────────────────────────────────
  // 驗簽必須對 GitHub 實際送出的位元組進行。Fastify 預設的 JSON parser 會
  // parse 掉 body，之後再 JSON.stringify 回去的位元組與原始位元組不同
  // （鍵序、空白、數字表示法都可能變），驗簽會失敗——或更糟，在多數情況下
  // 「剛好」通過，於是有人加上寬鬆處理來繞過它。
  //
  // 因此這裡註冊一個只回傳 Buffer 的 parser，parse 交給 handler 在驗簽之後做。
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  app.post('/webhooks/github', async (req, reply) => {
    const rawBody = req.body;
    if (!Buffer.isBuffer(rawBody)) {
      // content-type 不是 application/json。GitHub 也支援 form-encoded，
      // 但我們的 App 設定只用 JSON，收到別的就是設定錯或有人在戳。
      req.log.warn({ contentType: req.headers['content-type'] }, 'webhook: 非 JSON 內容型別');
      return reply.code(415).send({ error: 'unsupported_media_type' });
    }

    // ── 1. 驗簽（在任何 parse 之前）───────────────────────────────────
    const verdict = verifyGitHubSignature(
      rawBody,
      headerValue(req, H_SIGNATURE),
      deps.webhookSecret,
    );

    if (!verdict.ok) {
      // 回給用戶端的訊息一律相同，不透露是缺標頭、格式錯、還是簽章不符——
      // 那等於免費告訴攻擊者他離成功還有多遠。細分原因只進日誌。
      req.log.warn(
        { reason: verdict.reason, delivery: headerValue(req, H_DELIVERY) },
        'webhook: 驗簽失敗',
      );
      return reply.code(401).send({ error: 'invalid_signature' });
    }

    // ── 2. 必要標頭 ──────────────────────────────────────────────────
    const deliveryId = headerValue(req, H_DELIVERY);
    const eventType = headerValue(req, H_EVENT);

    if (deliveryId === undefined || eventType === undefined) {
      // 簽章對了但標頭不全：這是合法來源送出的畸形請求，記錄但不重送。
      req.log.warn({ deliveryId, eventType }, 'webhook: 已驗簽但缺少必要標頭');
      return reply.code(200).send({ status: 'ignored' });
    }

    // ── 3. 事件類型過濾（只看標頭，不 parse body）────────────────────
    // 簽章正確不代表我們要處理。放進佇列的每一筆都會佔用該 installation 的
    // 處理配額，無關事件會稀釋掉 per-installation rate limit 的效果。
    if (!SUBSCRIBED_EVENTS.has(eventType)) {
      req.log.info({ deliveryId, eventType }, 'webhook: 未訂閱的事件類型，略過');
      return reply.code(200).send({ status: 'skipped' });
    }

    // ── 4. 落庫 + 去重（由 `enqueue` 內部委派，見 `src/queue/enqueue.ts`）──
    // ⚠️ 去重不是這一層做的。`SPEC.md` §4 的圖把「去重」畫在 ① 步驟裡容易讓人
    // 以為 handler 自己做，實際上 handler 只是把它委派出去。三層防護
    // （THREAT_MODEL.md §5.2）全部實作於 `enqueue.ts`/`repositories.ts`：
    // 層 1 delivery_id UNIQUE（冪等性，非安全）、層 2 (run_id, run_attempt)
    // UNIQUE（真正的防重放主力，鍵來自受簽章保護的 payload 內容）、
    // 層 3 新鮮度視窗（拒絕 15 分鐘前的 workflow_run.updated_at）。
    // 見 docs/redteam/P1-09-webhook-replay.md RT1-01：這三層曾經只有層 1
    // 真的在跑，層 2/3 的資料庫索引存在但從未被寫入非 NULL 值。
    let outcome: EnqueueOutcome;
    try {
      outcome = await deps.enqueue({
        deliveryId,
        eventType,
        rawBody,
        receivedAt: new Date().toISOString(),
      });
    } catch (err) {
      // R4：絕不靜默。落庫失敗回 503 讓 GitHub 重送，比默默丟掉好。
      req.log.error({ err, deliveryId, eventType }, 'webhook: 落庫失敗');
      return reply.code(503).send({ error: 'temporarily_unavailable' });
    }

    if (outcome === 'unavailable') {
      req.log.warn({ deliveryId }, 'webhook: 佇列不可用，請 GitHub 重送');
      return reply.code(503).send({ error: 'temporarily_unavailable' });
    }

    req.log.info({ deliveryId, eventType, outcome }, 'webhook: 已接受');
    return reply.code(200).send({ status: outcome });
  });
}
