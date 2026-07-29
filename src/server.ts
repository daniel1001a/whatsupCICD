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

    // R3：webhook 必須 3 秒內回 200。連線層的逾時設得比業務預算更寬鬆，
    // 真正的預算控制在 handler 內。
    connectionTimeout: 10_000,
    requestTimeout: 30_000,

    // 驗簽必須對 raw bytes 進行（THREAT_MODEL.md §5）。body 上限同時是
    // 一道 DoS 防護——GitHub 的 workflow_run payload 遠小於此。
    bodyLimit: 2 * 1024 * 1024,

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
