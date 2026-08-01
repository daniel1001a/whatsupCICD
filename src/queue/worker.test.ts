/**
 * `Worker` 測試：孤兒回收、retry → backoff → dead 的完整進程、乾淨停止。
 *
 * 全部用 `:memory:` DB + 真正的 `EventRepository`（不是 mock），時鐘與亂數
 * 一律注入，不依賴假計時器（`vi.useFakeTimers`）——`runOnce()` 是刻意設計
 * 成可以逐筆決定性驅動的入口，見 `worker.ts` 的說明。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createConnection } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { EventRepository, InstallationRepository } from '../db/repositories.js';
import type { EventRow } from '../types/db.js';
import type { RetryPolicy } from '../types/events.js';
import { Worker, type EventHandler, type EventHandlerResult } from './worker.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

function freshDb(): Database.Database {
  const db = createConnection(':memory:');
  runMigrations(db, migrationsDir);
  return db;
}

function seedInstallation(db: Database.Database, ghInstallationId = 1): string {
  const row = new InstallationRepository(db).upsert({
    ghInstallationId,
    accountLogin: 'acme',
    accountType: 'Organization',
    slackTeamId: null,
    slackChannelId: null,
    installedAt: '2026-01-01T00:00:00.000Z',
  });
  return row.id;
}

function expectDefined<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`預期存在但讀不到：${what}`);
  return value;
}

/** 一個回傳固定結果或拋出固定錯誤的 handler，記錄每次呼叫收到的 event。 */
function stubHandler(
  impl: (event: EventRow) => Promise<EventHandlerResult> | EventHandlerResult,
): EventHandler & { readonly calls: EventRow[] } {
  const calls: EventRow[] = [];
  return {
    calls,
    handle: (event: EventRow) => {
      calls.push(event);
      return impl(event);
    },
  };
}

/** 建一個可以從測試外部手動 resolve 的 Promise，用來精確控制 handler 何時完成。 */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const FAST_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
  backoffMultiplier: 2,
};

describe('Worker.start — 開機孤兒回收', () => {
  it('claimed_at 早於門檻的 processing 事件會被回收（回傳筆數）', async () => {
    const db = freshDb();
    const installationId = seedInstallation(db);
    const eventRepo = new EventRepository(db);
    eventRepo.insertPending({
      deliveryId: 'orphan-1',
      installationId,
      eventType: 'workflow_run',
      repoFullName: 'acme/widgets',
      runId: 1,
      runAttempt: 1,
      runUpdatedAt: '2026-07-29T00:00:00.000Z',
      receivedAt: '2026-07-29T00:00:00.000Z',
      rawBody: Buffer.from('{}'),
    });
    const claimed = expectDefined(eventRepo.claimNext('2026-07-29T00:00:00.000Z'), 'claimed');
    expect(claimed.status).toBe('processing');

    // worker 的時鐘固定在 1 小時後；孤兒門檻只有 1 秒 → 遠遠過期，應被回收。
    const handler = stubHandler(() => 'done');
    const worker = new Worker({
      eventRepo,
      handler,
      now: () => '2026-07-29T01:00:00.000Z',
      orphanThresholdMs: 1_000,
      pollIntervalMs: 5,
    });

    const reclaimed = worker.start();
    expect(reclaimed).toBe(1);

    await worker.stop();
    // 回收後這筆孤兒重新進入佇列，worker 的迴圈把它撿起來並成功處理完。
    expect(expectDefined(eventRepo.findById(claimed.id), 'after reclaim+process').status).toBe(
      'done',
    );
  });

  it('claimed_at 未過門檻的 processing 事件不會被動到', async () => {
    const db = freshDb();
    const installationId = seedInstallation(db);
    const eventRepo = new EventRepository(db);
    eventRepo.insertPending({
      deliveryId: 'fresh-1',
      installationId,
      eventType: 'workflow_run',
      repoFullName: 'acme/widgets',
      runId: 2,
      runAttempt: 1,
      runUpdatedAt: '2026-07-29T00:00:00.000Z',
      receivedAt: '2026-07-29T00:00:00.000Z',
      rawBody: Buffer.from('{}'),
    });
    const claimed = expectDefined(eventRepo.claimNext('2026-07-29T00:00:00.000Z'), 'claimed');

    // 門檻 10 分鐘，但只過了 1 秒 → 不該被回收。
    const handler = stubHandler(() => 'done');
    const worker = new Worker({
      eventRepo,
      handler,
      now: () => '2026-07-29T00:00:01.000Z',
      orphanThresholdMs: 10 * 60_000,
      pollIntervalMs: 5,
    });

    const reclaimed = worker.start();
    expect(reclaimed).toBe(0);

    await worker.stop();
    expect(handler.calls).toHaveLength(0);
    expect(expectDefined(eventRepo.findById(claimed.id), 'untouched').status).toBe('processing');
  });
});

describe('Worker.runOnce — retry → backoff → dead 進程', () => {
  it('連續失敗直到 maxAttempts，逐次退避、最後進死信', async () => {
    const db = freshDb();
    const installationId = seedInstallation(db);
    const eventRepo = new EventRepository(db);
    eventRepo.insertPending({
      deliveryId: 'flaky-1',
      installationId,
      eventType: 'workflow_run',
      repoFullName: 'acme/widgets',
      runId: 3,
      runAttempt: 1,
      runUpdatedAt: '2026-07-29T00:00:00.000Z',
      receivedAt: '2026-07-29T00:00:00.000Z',
      rawBody: Buffer.from('{}'),
    });

    let clock = '2026-07-29T00:00:00.000Z';
    const handler = stubHandler(() => {
      throw new Error('boom');
    });
    const worker = new Worker({
      eventRepo,
      handler,
      now: () => clock,
      retryPolicy: FAST_RETRY_POLICY,
      random: () => 1, // full jitter 上界，讓 next_attempt_at 可預測
    });

    const eventId = expectDefined(
      db
        .prepare<[string], { readonly id: string }>(`SELECT id FROM events WHERE delivery_id = ?`)
        .get('flaky-1'),
      'seed',
    ).id;

    // 第 1 次失敗：attempts 0 → 1，1 < maxAttempts(3) → markFailed。
    expect(await worker.runOnce()).toBe('processed');
    let row = expectDefined(eventRepo.findById(eventId), 'after 1st failure');
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe('Error: boom');
    // backoff(1) with random=1 → initialDelayMs = 1000ms
    expect(row.next_attempt_at).toBe('2026-07-29T00:00:01.000Z');

    // 還沒到 next_attempt_at：claimNext 撿不到，runOnce 回傳 idle。
    expect(await worker.runOnce()).toBe('idle');
    expect(handler.calls).toHaveLength(1);

    // 時間走到 next_attempt_at，第 2 次失敗：attempts 1 → 2，2 < 3 → markFailed。
    clock = row.next_attempt_at ?? clock;
    expect(await worker.runOnce()).toBe('processed');
    row = expectDefined(eventRepo.findById(eventId), 'after 2nd failure');
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(2);
    // backoff(2) with random=1 → initialDelayMs * multiplier^1 = 2000ms
    expect(row.next_attempt_at).toBe('2026-07-29T00:00:03.000Z');

    // 第 3 次失敗：attempts 2 → 3，3 >= maxAttempts(3) → markDead（終態）。
    clock = row.next_attempt_at ?? clock;
    expect(await worker.runOnce()).toBe('processed');
    row = expectDefined(eventRepo.findById(eventId), 'after dead');
    expect(row.status).toBe('dead');
    expect(row.attempts).toBe(3);
    expect(row.last_error).toBe('Error: boom');
    expect(row.completed_at).toBe(clock);

    // 死信不再被撿起。
    expect(await worker.runOnce()).toBe('idle');
    expect(handler.calls).toHaveLength(3);
  });

  it('handler 回傳 done → markDone', async () => {
    const db = freshDb();
    const installationId = seedInstallation(db);
    const eventRepo = new EventRepository(db);
    eventRepo.insertPending({
      deliveryId: 'ok-1',
      installationId,
      eventType: 'workflow_run',
      repoFullName: 'acme/widgets',
      runId: 4,
      runAttempt: 1,
      runUpdatedAt: '2026-07-29T00:00:00.000Z',
      receivedAt: '2026-07-29T00:00:00.000Z',
      rawBody: Buffer.from('{}'),
    });
    const handler = stubHandler(() => 'done');
    const worker = new Worker({ eventRepo, handler, now: () => '2026-07-29T00:05:00.000Z' });

    expect(await worker.runOnce()).toBe('processed');
    const eventId = expectDefined(
      db
        .prepare<[string], { readonly id: string }>(`SELECT id FROM events WHERE delivery_id = ?`)
        .get('ok-1'),
      'seed',
    ).id;
    const row = expectDefined(eventRepo.findById(eventId), 'after done');
    expect(row.status).toBe('done');
    expect(row.completed_at).toBe('2026-07-29T00:05:00.000Z');
  });

  it('handler 回傳 skip → markSkipped', async () => {
    const db = freshDb();
    const installationId = seedInstallation(db);
    const eventRepo = new EventRepository(db);
    eventRepo.insertPending({
      deliveryId: 'skip-1',
      installationId,
      eventType: 'workflow_run',
      repoFullName: 'acme/widgets',
      runId: 5,
      runAttempt: 1,
      runUpdatedAt: '2026-07-29T00:00:00.000Z',
      receivedAt: '2026-07-29T00:00:00.000Z',
      rawBody: Buffer.from('{}'),
    });
    const handler = stubHandler(() => 'skip');
    const worker = new Worker({ eventRepo, handler, now: () => '2026-07-29T00:05:00.000Z' });

    expect(await worker.runOnce()).toBe('processed');
    const eventId = expectDefined(
      db
        .prepare<[string], { readonly id: string }>(`SELECT id FROM events WHERE delivery_id = ?`)
        .get('skip-1'),
      'seed',
    ).id;
    const row = expectDefined(eventRepo.findById(eventId), 'after skip');
    expect(row.status).toBe('skipped');
  });

  it('沒有可處理的事件時回傳 idle', async () => {
    const db = freshDb();
    const eventRepo = new EventRepository(db);
    const handler = stubHandler(() => 'done');
    const worker = new Worker({ eventRepo, handler, now: () => '2026-07-29T00:00:00.000Z' });

    expect(await worker.runOnce()).toBe('idle');
    expect(handler.calls).toHaveLength(0);
  });
});

describe('Worker.stop — 乾淨停止', () => {
  it('停止時等待進行中的處理完成，不留下 processing 孤兒', async () => {
    const db = freshDb();
    const installationId = seedInstallation(db);
    const eventRepo = new EventRepository(db);
    eventRepo.insertPending({
      deliveryId: 'inflight-1',
      installationId,
      eventType: 'workflow_run',
      repoFullName: 'acme/widgets',
      runId: 6,
      runAttempt: 1,
      runUpdatedAt: '2026-07-29T00:00:00.000Z',
      receivedAt: '2026-07-29T00:00:00.000Z',
      rawBody: Buffer.from('{}'),
    });
    const eventId = expectDefined(
      db
        .prepare<[string], { readonly id: string }>(`SELECT id FROM events WHERE delivery_id = ?`)
        .get('inflight-1'),
      'seed',
    ).id;

    const gate = deferred<EventHandlerResult>();
    const handler: EventHandler = { handle: () => gate.promise };
    const worker = new Worker({
      eventRepo,
      handler,
      now: () => '2026-07-29T00:00:00.000Z',
      pollIntervalMs: 5,
    });

    // start() 同步執行到 handler.handle() 第一個 await 為止——回傳時，
    // 這筆事件已經被 claim 成 processing，handler 正卡在 gate.promise 上。
    worker.start();
    expect(expectDefined(eventRepo.findById(eventId), 'mid-flight').status).toBe('processing');

    const stopping = worker.stop();
    // stop() 必須等 in-flight 完成，這裡先讓它「完成」再 await，
    // 驗證停止流程確實等到了，而不是提早放行留下孤兒。
    gate.resolve('done');
    await stopping;

    expect(expectDefined(eventRepo.findById(eventId), 'after stop').status).toBe('done');
  });
});
