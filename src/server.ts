/**
 * Fastify 應用組裝。
 *
 * 這裡只負責把各個路由與外掛接起來，不含業務邏輯。
 */
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppEnv } from './config/env.js';
import { buildLoggerOptions } from './logging.js';
import { registerHealthRoutes } from './routes/health.js';
import {
  registerWebhookRoutes,
  type EnqueueOutcome,
  type IncomingEvent,
} from './routes/webhook.js';

export interface BuildServerOptions {
  readonly env: AppEnv;
  /** 就緒判定。尚未接上 DB 與 queue 前，預設永遠就緒。 */
  readonly isReady?: () => boolean;
  /**
   * 事件落庫與排程。`P1-06` 的持久化 queue 完成後由 `main.ts` 注入真正的實作；
   * 未注入時用一個明確會告警的 no-op，**不會靜默丟事件**（R4）。
   */
  readonly enqueue?: (event: IncomingEvent) => Promise<EnqueueOutcome> | EnqueueOutcome;
}

export function buildServer({ env, isReady, enqueue }: BuildServerOptions): FastifyInstance {
  const app = Fastify({
    logger: buildLoggerOptions(env.logLevel, env.nodeEnv === 'development'),

    // ── 逾時（redteam P1-09 #1）────────────────────────────────────────
    // `connectionTimeout` 是 **idle-reset**：收到任何一個位元組就重置計時器。
    // redteam 實測以 4 秒間隔 trickle 資料，連線在 20 秒內完全沒被中斷。
    // 真正的絕對上限是 `requestTimeout`（Node 的 server.requestTimeout），
    // 它從請求開始計時且不因收到資料而重置——原本設 30 秒，等於給了
    // Slowloris 30 秒的免費持有時間。R3 的預算是 3 秒，這裡給 5 秒緩衝。
    connectionTimeout: 5_000,
    requestTimeout: 5_000,
    keepAliveTimeout: 5_000,

    // ── body 上限（redteam P1-09 #2）──────────────────────────────────
    // 驗簽必須對 raw bytes 進行（THREAT_MODEL.md §5）。
    //
    // 上限同時是 CPU DoS 的防線，而不只是記憶體防線：`createHmac().update()`
    // 是**同步**呼叫，在單執行緒的 event loop 上是真正的阻塞。redteam 實測
    // 15 個併發的 2MB 請求（簽章全錯，攻擊者不需要知道 secret）就讓
    // /healthz 從 ~2ms 飆到 145ms——足以讓 Fly.io 的健康檢查誤判機器不健康。
    //
    // GitHub 的 workflow_run payload 實測約 20–50KB。512KB 給了 10 倍餘裕，
    // 同時把單次 HMAC 的最壞成本降到原本的 1/4。
    bodyLimit: 512 * 1024,

    // 不信任任意 X-Forwarded-For；部署在 Fly.io 之後再依實際拓撲調整。
    trustProxy: false,
  });

  registerHealthRoutes(app, { isReady: isReady ?? (() => true) });

  registerWebhookRoutes(app, {
    webhookSecret: env.githubWebhookSecret,
    enqueue:
      enqueue ??
      ((event): EnqueueOutcome => {
        // R4 不靜默失敗：queue 還沒接上時，回 unavailable 讓 GitHub 重送，
        // 而不是假裝收下再丟掉。這個分支在 P1-06 完成後就不會再被走到。
        app.log.error(
          { deliveryId: event.deliveryId, eventType: event.eventType },
          'webhook: queue 尚未接上（P1-06），拒收以觸發 GitHub 重送',
        );
        return 'unavailable';
      }),
  });

  return app;
}
