/**
 * 進入點。負責載入設定、組裝伺服器、啟動、以及優雅關閉。
 *
 * 優雅關閉是 R4 的一部分：SIGTERM 時若直接死掉，正在處理中的事件會變成
 * `processing` 孤兒。完整的 worker 收斂邏輯於 `P4-03` 補上，此處先確保
 * HTTP 層會停止收新連線並等待既有請求結束。
 */
import { loadEnv } from './config/env.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const app = buildServer({ env });

  const shutdown = (signal: string): void => {
    app.log.info({ signal }, '收到終止訊號，開始優雅關閉');
    app
      .close()
      .then(() => {
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
