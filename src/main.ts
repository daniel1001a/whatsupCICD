/**
 * 進入點。負責載入設定、組裝伺服器、啟動、以及優雅關閉。
 *
 * 優雅關閉是 R4 的一部分：SIGTERM 時若直接死掉，正在處理中的事件會變成
 * `processing` 孤兒。完整的 worker 收斂邏輯於 `P4-03` 補上，此處先確保
 * HTTP 層會停止收新連線並等待既有請求結束。
 *
 * ⚠️ 這裡只接上 `enqueue`（落庫），**不**啟動 `Worker`（P1-06 的
 * `src/queue/worker.ts`）：`Worker` 需要一個真正的 `EventHandler`（抓 log、
 * sanitize、呼叫 LLM、投遞 Slack），那是 Phase 2/3 的產物。若現在用一個
 * 空的 stub handler 啟動 Worker，事件會被 `claimNext` 撿走、標記 `done`，
 * 卻從未被真正處理——這是比「完全不啟動 worker」更糟的靜默事件遺失
 * （R4 違反）。啟動 Worker 排入 Phase 2 收尾（`P2-10` 前）。
 *
 * DB migration 不在此自動執行，遵循 `scripts/migrate.ts` 既有慣例：
 * 部署流程需先跑 `npm run migrate` 再啟動本進程。未 migrate 的資料庫會讓
 * `enqueue` 內部的 INSERT 拋錯，被 `createEnqueue` 的 catch-all 轉成
 * `'unavailable'` → 503（R4：GitHub 會重送，不是靜默丟棄）。
 */
import { loadEnv } from './config/env.js';
import { buildServer } from './server.js';
import { createConnection } from './db/connection.js';
import { EventRepository } from './db/repositories.js';
import { createEnqueue } from './queue/enqueue.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createConnection(env.databasePath);
  const enqueue = createEnqueue(new EventRepository(db));
  const app = buildServer({ env, enqueue });

  const shutdown = (signal: string): void => {
    app.log.info({ signal }, '收到終止訊號，開始優雅關閉');
    app
      .close()
      .then(() => {
        db.close();
        app.log.info('已關閉');
        process.exit(0);
      })
      .catch((err: unknown) => {
        app.log.error({ err }, '關閉時發生錯誤');
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });

  await app.listen({ port: env.port, host: '0.0.0.0' });
}

main().catch((err: unknown) => {
  // 啟動失敗時 logger 可能還沒建立，這是唯一允許寫 stderr 的地方。
  process.stderr.write(`啟動失敗：${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
