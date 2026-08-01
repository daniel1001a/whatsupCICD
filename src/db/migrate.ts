/**
 * Migration 執行器。
 *
 * 讀 `migrations/*.sql`，依檔名排序執行；已執行過的版本記在 `schema_migrations`，
 * 可重跑且冪等；每個 migration 檔在單一交易內執行，失敗即整個 rollback
 * （better-sqlite3 的 `db.transaction()` 在拋出例外時會自動 ROLLBACK）。
 *
 * `schema_migrations` 表本身是由 `migrations/0001_init.sql` 建立的，因此第一次
 * 執行時該表尚不存在——用 `sqlite_master` 判斷是否存在，避免在全新 DB 上
 * 查詢一張還沒被建立的表而出錯。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare<[string], { readonly name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    )
    .get(name);
  return row !== undefined;
}

/** 從檔名（如 `0001_init.sql`）取出版本號（`0001`）。 */
function extractVersion(filename: string): string {
  const match = /^(\d+)_/.exec(filename);
  const version = match?.[1];
  if (version === undefined) {
    throw new Error(`migration 檔名必須以數字版本號開頭（如 0001_init.sql）：${filename}`);
  }
  return version;
}

function isAlreadyApplied(db: Database.Database, version: string): boolean {
  if (!tableExists(db, 'schema_migrations')) return false;
  const row = db
    .prepare<[string], { readonly version: string }>(
      `SELECT version FROM schema_migrations WHERE version = ?`,
    )
    .get(version);
  return row !== undefined;
}

/** 依檔名排序執行 `migrationsDir` 下所有 `.sql` 檔。回傳本次實際套用的版本清單
 * （已套用過的版本不會出現在回傳值裡）。 */
export function runMigrations(db: Database.Database, migrationsDir: string): readonly string[] {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied: string[] = [];

  for (const file of files) {
    const version = extractVersion(file);
    if (isAlreadyApplied(db, version)) continue;

    const sql = readFileSync(join(migrationsDir, file), 'utf8');

    const applyOne = db.transaction((): void => {
      db.exec(sql);
      db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`).run(
        version,
        new Date().toISOString(),
      );
    });
    applyOne();

    applied.push(version);
  }

  return applied;
}
