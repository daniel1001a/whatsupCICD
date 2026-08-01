/**
 * better-sqlite3 連線建立與 PRAGMA 設定。
 *
 * SPEC.md §10 相容性原則 + CLAUDE.md R2：
 *   - `foreign_keys = ON` 不可省略——`feedback.case_id` 等外鍵約束是
 *     SPEC.md §4「先落庫後投遞」設計的一部分（見 db/repositories.ts 的說明）。
 *   - WAL + `synchronous = NORMAL` 是官方建議的耐用/效能折衷。
 *   - `busy_timeout` 讓短暫的寫入鎖定改為等待，而不是立即拋錯。
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** 開啟一個設定好 PRAGMA 的 better-sqlite3 連線。
 *
 * @param path 資料庫檔案路徑，或 `:memory:`（供測試用，不落地）。
 *             檔案路徑的父目錄不存在時會自動建立。
 */
export function createConnection(path: string): Database.Database {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path);

  // WAL 對 :memory: DB 沒有意義，better-sqlite3 會自動改用 'memory'，不會出錯。
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  return db;
}
