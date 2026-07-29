/**
 * CLI：對 `DATABASE_PATH` 指定的 SQLite 檔案套用所有待執行的 migration。
 *
 * 用法：`npm run migrate`（package.json 的 "migrate" script）。
 * 讀 `DATABASE_PATH` 環境變數（預設 `./data/prosecutor.sqlite`，見
 * `src/config/env.ts` 與 `.env.example`）。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnv } from '../src/config/env.js';
import { createConnection } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

function main(): void {
  const env = loadEnv();
  console.log(`[migrate] 資料庫：${env.databasePath}`);
  console.log(`[migrate] migrations 目錄：${migrationsDir}`);

  const db = createConnection(env.databasePath);
  try {
    const applied = runMigrations(db, migrationsDir);
    if (applied.length === 0) {
      console.log('[migrate] 沒有待套用的 migration，資料庫已是最新版本。');
    } else {
      console.log(`[migrate] 已套用 ${applied.length} 個 migration：${applied.join(', ')}`);
    }
  } finally {
    db.close();
  }
}

main();
