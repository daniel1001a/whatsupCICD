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

/**
 * P1-09 redteam RT1-01 / RT1-02 / RT1-04 回歸測試
 * （`docs/redteam/P1-09-webhook-replay.md`）。
 *
 * RT1-01 的原始破解手法：側錄一個合法的 `(body, 簽章)`，用偽造的
 * `X-GitHub-Delivery` 重放無限次——每次都是新的 delivery_id，層 1 擋不住，
 * 而層 2（`run_id`/`run_attempt`）當時固定寫入 `null`，partial unique index
 * 根本看不到這些列。以下測試直接重現這個手法（同一個 body，只換
 * delivery_id），斷言第二次必須被層 2 擋下。
 */
describe('createEnqueue — THREAT_MODEL.md §5.2 三層重放防禦', () => {
  /** 建一個最小可用的 workflow_run payload，供 extractWorkflowRunKey 解析。 */
  function makeWorkflowRunBody(overrides: {
    readonly runId?: number;
    readonly runAttempt?: number;
    readonly updatedAt?: string;
  }): Buffer {
    return Buffer.from(
      JSON.stringify({
        action: 'completed',
        workflow_run: {
          id: overrides.runId ?? 555,
          run_attempt: overrides.runAttempt ?? 1,
          updated_at: overrides.updatedAt ?? '2026-08-01T12:00:00.000Z',
        },
      }),
    );
  }

  it('RT1-01 回歸：同一個 body、偽造不同 delivery_id 重放 → 第二次被層 2 擋下（duplicate）', () => {
    const db = freshDb();
    const enqueue = createEnqueue(new EventRepository(db), {
      now: () => new Date('2026-08-01T12:01:00.000Z'),
    });
    const capturedBody = makeWorkflowRunBody({ runId: 999, runAttempt: 1 });

    // 攻擊者側錄到 (body, 簽章) 後不需要知道 secret，就能自己捏造無限個
    // delivery_id 重放同一份合法 body。
    expect(
      enqueue(makeEvent({ deliveryId: 'attacker-forged-uuid-0', rawBody: capturedBody })),
    ).toBe('accepted');
    expect(
      enqueue(makeEvent({ deliveryId: 'attacker-forged-uuid-1', rawBody: capturedBody })),
    ).toBe('duplicate');
    expect(
      enqueue(makeEvent({ deliveryId: 'attacker-forged-uuid-2', rawBody: capturedBody })),
    ).toBe('duplicate');

    const row = db.prepare<[], { readonly n: number }>(`SELECT COUNT(*) as n FROM events`).get();
    expect(row?.n).toBe(1); // 5 次重放的原始 redteam 重現只留下 1 筆，這裡驗證同樣結果
  });

  it('RT1-01 回歸：run_id/run_attempt 實際寫入非 NULL（層 2 索引真的看得到這些列）', () => {
    const db = freshDb();
    const enqueue = createEnqueue(new EventRepository(db), {
      now: () => new Date('2026-08-01T12:01:00.000Z'),
    });

    enqueue(makeEvent({ deliveryId: 'd-1', rawBody: makeWorkflowRunBody({ runId: 777 }) }));

    const row = db
      .prepare<[], { readonly run_id: number | null; readonly run_attempt: number | null }>(
        `SELECT run_id, run_attempt FROM events WHERE delivery_id = 'd-1'`,
      )
      .get();
    expect(row?.run_id).toBe(777);
    expect(row?.run_attempt).toBe(1);
  });

  it('RT1-04 回歸：同一個 run_id、不同 run_attempt（合法重跑）→ 都是 accepted，不誤判成重複', () => {
    const db = freshDb();
    const enqueue = createEnqueue(new EventRepository(db), {
      now: () => new Date('2026-08-01T12:01:00.000Z'),
    });

    expect(
      enqueue(
        makeEvent({
          deliveryId: 'd-attempt-1',
          rawBody: makeWorkflowRunBody({ runId: 42, runAttempt: 1 }),
        }),
      ),
    ).toBe('accepted');
    expect(
      enqueue(
        makeEvent({
          deliveryId: 'd-attempt-2',
          rawBody: makeWorkflowRunBody({ runId: 42, runAttempt: 2 }),
        }),
      ),
    ).toBe('accepted');
  });

  it('層 3 新鮮度視窗：updated_at 早於 15 分鐘 → stale，不落庫', () => {
    const db = freshDb();
    const enqueue = createEnqueue(new EventRepository(db), {
      now: () => new Date('2026-08-01T12:20:00.000Z'), // 距 updated_at 20 分鐘
    });

    expect(
      enqueue(
        makeEvent({
          deliveryId: 'stale-1',
          rawBody: makeWorkflowRunBody({ updatedAt: '2026-08-01T12:00:00.000Z' }),
        }),
      ),
    ).toBe('stale');

    const row = db.prepare<[], { readonly n: number }>(`SELECT COUNT(*) as n FROM events`).get();
    expect(row?.n).toBe(0);
  });

  it('層 3 新鮮度視窗：15 分鐘視窗內（含部署中斷積壓情境）→ 正常 accepted', () => {
    const db = freshDb();
    const enqueue = createEnqueue(new EventRepository(db), {
      now: () => new Date('2026-08-01T12:14:00.000Z'), // 距 updated_at 14 分鐘，未超過視窗
    });

    expect(
      enqueue(
        makeEvent({
          deliveryId: 'fresh-1',
          rawBody: makeWorkflowRunBody({ updatedAt: '2026-08-01T12:00:00.000Z' }),
        }),
      ),
    ).toBe('accepted');
  });

  it('R4：畸形 workflow_run body（欄位缺漏）不拒收，退化成只靠層 1 去重', () => {
    const db = freshDb();
    const enqueue = createEnqueue(new EventRepository(db));

    const malformed = Buffer.from(JSON.stringify({ action: 'completed', workflow_run: {} }));
    expect(enqueue(makeEvent({ deliveryId: 'malformed-1', rawBody: malformed }))).toBe('accepted');

    const row = db
      .prepare<[], { readonly run_id: number | null }>(
        `SELECT run_id FROM events WHERE delivery_id = 'malformed-1'`,
      )
      .get();
    expect(row?.run_id).toBeNull();
  });

  it('R4：完全非 JSON 的 body（不是 workflow_run 事件不會走到這段解析，但驗證 workflow_run 型別下也不拋出）', () => {
    const db = freshDb();
    const enqueue = createEnqueue(new EventRepository(db));

    const garbage = Buffer.from('not json at all {{{');
    expect(() => enqueue(makeEvent({ deliveryId: 'garbage-1', rawBody: garbage }))).not.toThrow();
    expect(enqueue(makeEvent({ deliveryId: 'garbage-2', rawBody: garbage }))).toBe('accepted');
  });
});
