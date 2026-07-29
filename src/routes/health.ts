/**
 * 健康檢查端點。
 *
 * `/healthz`  — 程序活著（liveness）。永遠回 200，除非程序已死。
 * `/readyz`   — 可以接流量（readiness）。DB 與 queue 就緒才回 200。
 *
 * 兩者皆不回傳任何內部狀態細節（版本號、路徑、依賴清單），
 * 未經驗證的端點不該成為情蒐來源。
 */
import type { FastifyInstance } from 'fastify';

export interface HealthRouteOptions {
  readonly isReady: () => boolean;
}

export function registerHealthRoutes(app: FastifyInstance, { isReady }: HealthRouteOptions): void {
  app.get('/healthz', (_req, reply) => {
    void reply.code(200).send({ status: 'ok' });
  });

  app.get('/readyz', (_req, reply) => {
    if (isReady()) {
      void reply.code(200).send({ status: 'ready' });
      return;
    }
    void reply.code(503).send({ status: 'not_ready' });
  });
}
