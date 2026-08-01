/**
 * `createEnqueue` 測試：webhook → events 表的落庫實作。
 *
 * 用 `:memory:` DB + 真正的 `EventRepository`（不是 mock）——去重是靠
 * `events` 表的 UNIQUE(delivery_id) 約束保證的，mock 掉 repository 會測不到
 * 這一點（正是 `webhook.ts` 註解裡強調「重放防護在 P1-06 之前完全是空的」
 * 的那個洞）。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createConnection } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { EventRepository } from '../db/repositories.js';
import type { IncomingEvent } from '../routes/webhook.js';
import { createEnqueue } from './enqueue.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

function freshDb(): Database.Database {
  const db = createConnection(':memory:');
  runMigrations(db, migrationsDir);
  return db;
}

function makeEvent(overrides: Partial<IncomingEvent> = {}): IncomingEvent {
  return {
    deliveryId: 'delivery-1',
    eventType: 'workflow_run',
    rawBody: Buffer.from(JSON.stringify({ hello: 'world' })),
    receivedAt: '2026-07-29T00:00:00.000Z',
    ...overrides,
  };
}

describe('createEnqueue', () => {
  it('第一次收到的 delivery_id → accepted', () => {
    const db = freshDb();
    const enqueue = createEnqueue(new EventRepository(db));

    expect(enqueue(makeEvent())).toBe('accepted');
  });

  it('同一個 delivery_id 第二次 → duplicate（去重防護）', () => {
    const db = freshDb();
    const enqueue = createEnqueue(new EventRepository(db));

    expect(enqueue(makeEvent())).toBe('accepted');
    expect(enqueue(makeEvent())).toBe('duplicate');

    const row = db
      .prepare<[string], { readonly n: number }>(
        `SELECT COUNT(*) as n FROM events WHERE delivery_id = ?`,
      )
      .get('delivery-1');
    expect(row?.n).toBe(1);
  });

  it('不認識的事件類型（例如 ping）→ skipped，不落庫', () => {
    const db = freshDb();
    const enqueue = createEnqueue(new EventRepository(db));

    expect(enqueue(makeEvent({ deliveryId: 'ping-1', eventType: 'ping' }))).toBe('skipped');

    const row = db.prepare<[], { readonly n: number }>(`SELECT COUNT(*) as n FROM events`).get();
    expect(row?.n).toBe(0);
  });

  it('落庫後 installation_id / repo_full_name 為 NULL，等 worker 回填', () => {
    const db = freshDb();
    const enqueue = createEnqueue(new EventRepository(db));

    enqueue(makeEvent());

    const row = db
      .prepare<
        [string],
        { readonly installation_id: string | null; readonly repo_full_name: string | null }
      >(`SELECT installation_id, repo_full_name FROM events WHERE delivery_id = ?`)
      .get('delivery-1');
    expect(row?.installation_id).toBeNull();
    expect(row?.repo_full_name).toBeNull();
  });

  it('R2 回歸：events 表裡找不到 raw body，只有 digest', () => {
    const db = freshDb();
    const enqueue = createEnqueue(new EventRepository(db));

    const canary = 'CANARY-SECRET-TOKEN-do-not-persist-enqueue';
    enqueue(
      makeEvent({
        deliveryId: 'canary-enqueue-1',
        rawBody: Buffer.from(JSON.stringify({ secret: canary })),
      }),
    );

    const rows: unknown[] = db.prepare(`SELECT * FROM events`).all();
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(canary);
    expect(serialized).toMatch(/"payload_digest":"[0-9a-f]{64}"/);
  });

  it('DB 已關閉（模擬不可用）→ unavailable，不拋出例外', () => {
    const db = freshDb();
    const eventRepo = new EventRepository(db);
    db.close();
    const enqueue = createEnqueue(eventRepo);

    expect(() => enqueue(makeEvent({ deliveryId: 'db-down' }))).not.toThrow();
    expect(enqueue(makeEvent({ deliveryId: 'db-down' }))).toBe('unavailable');
  });

  it.each(['workflow_run', 'installation', 'installation_repositories'] as const)(
    '訂閱的事件類型 %s → accepted',
    (eventType) => {
      const db = freshDb();
      const enqueue = createEnqueue(new EventRepository(db));

      expect(enqueue(makeEvent({ deliveryId: `sub-${eventType}`, eventType }))).toBe('accepted');
    },
  );
});
