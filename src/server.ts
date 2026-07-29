/**
 * Fastify 應用組裝。
 *
 * 這裡只負責把各個路由與外掛接起來，不含業務邏輯。
 * webhook 路由（含 HMAC 驗簽與 raw body 保留）於 `P1-04` 加入。
 */
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppEnv } from './config/env.js';
import { buildLoggerOptions } from './logging.js';
import { registerHealthRoutes } from './routes/health.js';

export interface BuildServerOptions {
  readonly env: AppEnv;
  /** 就緒判定。尚未接上 DB 與 queue 前，預設永遠就緒。 */
  readonly isReady?: () => boolean;
}

export function buildServer({ env, isReady }: BuildServerOptions): FastifyInstance {
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

  return app;
}
