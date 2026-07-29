/**
 * SQLite 持久層測試（SPEC.md §10、CLAUDE.md R2/R4）。
 *
 * 全部用 `:memory:` DB，不落地、跑得快、彼此隔離。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createConnection } from './connection.js';
import { runMigrations } from './migrate.js';
import {
  CaseRepository,
  EventRepository,
  FeedbackRepository,
  InstallationRepository,
  LlmUsageRepository,
  type NewCaseInput,
} from './repositories.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

function expectDefined<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`預期存在但讀不到：${what}`);
  return value;
}

/** 建一個乾淨的 in-memory DB，套用全部 migration。 */
function freshDb(): Database.Database {
  const db = createConnection(':memory:');
  runMigrations(db, migrationsDir);
  return db;
}

/** 建一個 installation，回傳其 id。 */
function seedInstallation(
  db: Database.Database,
  ghInstallationId: number,
  accountLogin = 'acme',
): string {
  const repo = new InstallationRepository(db);
  const row = repo.upsert({
    ghInstallationId,
    accountLogin,
    accountType: 'Organization',
    slackTeamId: null,
    slackChannelId: null,
    installedAt: '2026-01-01T00:00:00.000Z',
  });
  return row.id;
}

let seedEventCounter = 0;

/** 建一個 event，回傳其 id。每次呼叫用不同的 run_id，避免撞到
 * `idx_events_run` 的 UNIQUE(run_id, run_updated_at) 索引。 */
function seedEvent(db: Database.Database, installationId: string, deliveryId: string): string {
  seedEventCounter += 1;
  const repo = new EventRepository(db);
  const outcome = repo.insertPending({
    deliveryId,
    installationId,
    eventType: 'workflow_run',
    repoFullName: 'acme/widgets',
    runId: seedEventCounter,
    runUpdatedAt: `2026-07-29T00:00:${String(seedEventCounter % 60).padStart(2, '0')}.000Z`,
    receivedAt: '2026-07-29T00:00:00.000Z',
    rawBody: Buffer.from('{}'),
  });
  expect(outcome).toBe('accepted');
  const row = expectDefined(
    db
      .prepare<[string], { readonly id: string }>(`SELECT id FROM events WHERE delivery_id = ?`)
      .get(deliveryId),
    'seedEvent',
  );
  return row.id;
}

function minimalCaseInput(
  overrides: Partial<NewCaseInput> = {},
): Omit<NewCaseInput, 'installationId' | 'eventId'> {
  return {
    repoFullName: 'acme/widgets',
    workflowName: 'CI',
    jobName: 'build',
    runUrl: 'https://github.com/acme/widgets/actions/runs/1',
    headSha: 'a'.repeat(40),
    branch: 'main',
    signatureHash: 'sig-abc',
    signatureFound: true,
    matchedPatternId: 'P_TS_ERROR',
    errorClass: 'E_COMPILE',
    severity: 'moderate',
    severityOpinion: 'moderate',
    confidence: 'medium',
    redactionRatio: 0,
    compressionLevel: 'C0',
    windowStartLine: 10,
    windowEndLine: 40,
    verdictJson: '{"charge":"test"}',
    isFallback: false,
    fallbackReason: null,
    isAnonymous: false,
    createdAt: '2026-07-29T00:00:00.000Z',
    ...overrides,
  };
}

describe('runMigrations', () => {
  it('是冪等的：第二次執行不會重跑已套用的 migration', () => {
    const db = createConnection(':memory:');

    const first = runMigrations(db, migrationsDir);
    expect(first).toContain('0001');
    expect(first.length).toBeGreaterThan(0);

    const second = runMigrations(db, migrationsDir);
    expect(second).toEqual([]);

    // 表確實建立好了，且沒有重複建立造成的錯誤
    const tables = db
      .prepare<[], { readonly name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
      )
      .all()
      .map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'installations',
        'events',
        'cases',
        'feedback',
        'meme_cards',
        'llm_usage',
        'verdict_cache',
        'schema_migrations',
      ]),
    );
  });
});

describe('EventRepository', () => {
  it('insertPending 對同一個 delivery_id 第二次回傳 duplicate', () => {
    const db = freshDb();
    const installationId = seedInstallation(db, 1);
    const repo = new EventRepository(db);

    const input = {
      deliveryId: 'dup-1',
      installationId,
      eventType: 'workflow_run' as const,
      repoFullName: 'acme/widgets',
      runId: 1,
      runUpdatedAt: '2026-07-29T00:00:00.000Z',
      receivedAt: '2026-07-29T00:00:00.000Z',
      rawBody: Buffer.from('{"first":true}'),
    };

    expect(repo.insertPending(input)).toBe('accepted');
    expect(repo.insertPending({ ...input, rawBody: Buffer.from('{"first":false}') })).toBe(
      'duplicate',
    );

    const count = expectDefined(
      db
        .prepare<[string], { readonly n: number }>(
          `SELECT COUNT(*) as n FROM events WHERE delivery_id = ?`,
        )
        .get('dup-1'),
      'count',
    );
    expect(count.n).toBe(1);
  });

  it('events 表裡找不到 raw body（R2 回歸測試）', () => {
    const db = freshDb();
    const installationId = seedInstallation(db, 2);
    const repo = new EventRepository(db);

    const canary = 'CANARY-SECRET-TOKEN-do-not-persist-38f0';
    repo.insertPending({
      deliveryId: 'canary-1',
      installationId,
      eventType: 'workflow_run',
      repoFullName: 'acme/widgets',
      runId: 2,
      runUpdatedAt: '2026-07-29T00:00:00.000Z',
      receivedAt: '2026-07-29T00:00:00.000Z',
      rawBody: Buffer.from(JSON.stringify({ secret: canary })),
    });

    const rows: unknown[] = db.prepare(`SELECT * FROM events`).all();
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(canary);
    // digest 應該存在且是 64 個 hex 字元（SHA-256）
    expect(serialized).toMatch(/"payload_digest":"[0-9a-f]{64}"/);
  });

  it('claimNext 併發呼叫兩次不會拿到同一筆', () => {
    const db = freshDb();
    const installationId = seedInstallation(db, 3);
    const repo = new EventRepository(db);

    repo.insertPending({
      deliveryId: 'ev-a',
      installationId,
      eventType: 'workflow_run',
      repoFullName: 'acme/widgets',
      runId: 10,
      runUpdatedAt: '2026-07-29T00:00:00.000Z',
      receivedAt: '2026-07-29T00:00:00.000Z',
      rawBody: Buffer.from('{}'),
    });
    repo.insertPending({
      deliveryId: 'ev-b',
      installationId,
      eventType: 'workflow_run',
      repoFullName: 'acme/widgets',
      runId: 11,
      runUpdatedAt: '2026-07-29T00:00:01.000Z',
      receivedAt: '2026-07-29T00:00:01.000Z',
      rawBody: Buffer.from('{}'),
    });

    const now = '2026-07-29T01:00:00.000Z';
    const first = repo.claimNext(now);
    const second = repo.claimNext(now);
    const third = repo.claimNext(now);

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(third).toBeUndefined();
    expect(first?.id).not.toBe(second?.id);
    expect(first?.status).toBe('processing');
    expect(second?.status).toBe('processing');
  });

  it('reclaimOrphans 能把卡住的 processing 改回 pending', () => {
    const db = freshDb();
    const installationId = seedInstallation(db, 4);
    const repo = new EventRepository(db);

    repo.insertPending({
      deliveryId: 'orphan-1',
      installationId,
      eventType: 'workflow_run',
      repoFullName: 'acme/widgets',
      runId: 20,
      runUpdatedAt: '2026-07-29T00:00:00.000Z',
      receivedAt: '2026-07-29T00:00:00.000Z',
      rawBody: Buffer.from('{}'),
    });

    const claimed = expectDefined(repo.claimNext('2026-07-29T00:00:00.000Z'), 'claimed');
    expect(claimed.status).toBe('processing');

    // 尚未過期的門檻：不應被回收
    const untouched = repo.reclaimOrphans('2026-01-01T00:00:00.000Z');
    expect(untouched).toBe(0);
    expect(expectDefined(repo.findById(claimed.id), 'still processing').status).toBe('processing');

    // 過期門檻：應被回收
    const reclaimed = repo.reclaimOrphans('2027-01-01T00:00:00.000Z');
    expect(reclaimed).toBe(1);
    expect(expectDefined(repo.findById(claimed.id), 'back to pending').status).toBe('pending');
  });

  it('countByStatus 回傳每個狀態的計數', () => {
    const db = freshDb();
    const installationId = seedInstallation(db, 5);
    const repo = new EventRepository(db);

    repo.insertPending({
      deliveryId: 'stat-1',
      installationId,
      eventType: 'workflow_run',
      repoFullName: 'acme/widgets',
      runId: 30,
      runUpdatedAt: '2026-07-29T00:00:00.000Z',
      receivedAt: '2026-07-29T00:00:00.000Z',
      rawBody: Buffer.from('{}'),
    });

    const counts = repo.countByStatus();
    expect(counts.pending).toBe(1);
    expect(counts.processing).toBe(0);
    expect(counts.done).toBe(0);
  });

  it('markFailed 遞增 attempts 並記錄 last_error，狀態回到 pending 以便重跑', () => {
    const db = freshDb();
    const installationId = seedInstallation(db, 6);
    const repo = new EventRepository(db);

    repo.insertPending({
      deliveryId: 'fail-1',
      installationId,
      eventType: 'workflow_run',
      repoFullName: 'acme/widgets',
      runId: 40,
      runUpdatedAt: '2026-07-29T00:00:00.000Z',
      receivedAt: '2026-07-29T00:00:00.000Z',
      rawBody: Buffer.from('{}'),
    });
    const claimed = expectDefined(repo.claimNext('2026-07-29T00:00:00.000Z'), 'claimed');

    repo.markFailed(claimed.id, 'LLM 逾時', '2026-07-29T02:00:00.000Z');

    const row = expectDefined(repo.findById(claimed.id), 'after markFailed');
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe('LLM 逾時');
    expect(row.next_attempt_at).toBe('2026-07-29T02:00:00.000Z');
  });

  it('markDead 是終態', () => {
    const db = freshDb();
    const installationId = seedInstallation(db, 7);
    const repo = new EventRepository(db);

    repo.insertPending({
      deliveryId: 'dead-1',
      installationId,
      eventType: 'workflow_run',
      repoFullName: 'acme/widgets',
      runId: 50,
      runUpdatedAt: '2026-07-29T00:00:00.000Z',
      receivedAt: '2026-07-29T00:00:00.000Z',
      rawBody: Buffer.from('{}'),
    });
    const claimed = expectDefined(repo.claimNext('2026-07-29T00:00:00.000Z'), 'claimed');

    repo.markDead(claimed.id, '超過最大重試次數', '2026-07-29T03:00:00.000Z');

    const row = expectDefined(repo.findById(claimed.id), 'after markDead');
    expect(row.status).toBe('dead');
    expect(row.completed_at).toBe('2026-07-29T03:00:00.000Z');
  });
});

describe('CaseRepository', () => {
  it('case_no 在同一 installation 內單調遞增、跨 installation 各自獨立', () => {
    const db = freshDb();
    const instA = seedInstallation(db, 100, 'team-a');
    const instB = seedInstallation(db, 101, 'team-b');
    const eventA1 = seedEvent(db, instA, 'a-1');
    const eventA2 = seedEvent(db, instA, 'a-2');
    const eventB1 = seedEvent(db, instB, 'b-1');

    const repo = new CaseRepository(db);

    const caseA1 = repo.create({
      ...minimalCaseInput(),
      installationId: instA,
      eventId: eventA1,
    });
    const caseA2 = repo.create({
      ...minimalCaseInput(),
      installationId: instA,
      eventId: eventA2,
    });
    const caseB1 = repo.create({
      ...minimalCaseInput(),
      installationId: instB,
      eventId: eventB1,
    });

    expect(caseA1.case_no).toBe(1);
    expect(caseA2.case_no).toBe(2);
    expect(caseB1.case_no).toBe(1);
  });

  it('attachSlackMessage 回填 channel/ts', () => {
    const db = freshDb();
    const instA = seedInstallation(db, 110);
    const eventId = seedEvent(db, instA, 'slack-1');
    const repo = new CaseRepository(db);

    const created = repo.create({ ...minimalCaseInput(), installationId: instA, eventId });
    expect(created.slack_channel_id).toBeNull();

    repo.attachSlackMessage(created.id, 'C123', '1234.5678');

    const row = expectDefined(repo.findById(created.id), 'after attach');
    expect(row.slack_channel_id).toBe('C123');
    expect(row.slack_ts).toBe('1234.5678');
  });

  it('countRecentBySignature 的時間窗正確', () => {
    const db = freshDb();
    const instA = seedInstallation(db, 120);
    const repo = new CaseRepository(db);

    const timestamps = [
      '2026-07-01T00:00:00.000Z', // 窗外（太舊）
      '2026-07-20T00:00:00.000Z', // 窗內
      '2026-07-25T00:00:00.000Z', // 窗內
      '2026-07-29T00:00:00.000Z', // 窗內
    ];
    for (const [i, ts] of timestamps.entries()) {
      const eventId = seedEvent(db, instA, `sig-${i}`);
      repo.create({
        ...minimalCaseInput({ createdAt: ts, signatureHash: 'sig-x' }),
        installationId: instA,
        eventId,
      });
    }

    const since = '2026-07-15T00:00:00.000Z';
    const count = repo.countRecentBySignature(instA, 'sig-x', since);
    expect(count).toBe(3);
  });

  it('markResolved 只回填尚未解決的同 signature case', () => {
    const db = freshDb();
    const instA = seedInstallation(db, 130);
    const repo = new CaseRepository(db);

    const event1 = seedEvent(db, instA, 'resolve-1');
    const case1 = repo.create({
      ...minimalCaseInput({ signatureHash: 'sig-r', createdAt: '2026-07-01T00:00:00.000Z' }),
      installationId: instA,
      eventId: event1,
    });

    repo.markResolved(instA, 'sig-r', '2026-07-02T00:00:00.000Z');

    const row = expectDefined(repo.findById(case1.id), 'after resolve');
    expect(row.resolved_at).toBe('2026-07-02T00:00:00.000Z');
  });
});

describe('外鍵約束', () => {
  it('對不存在的 case_id 插入 feedback 會失敗', () => {
    const db = freshDb();
    const repo = new FeedbackRepository(db);

    expect(() =>
      repo.upsert('nonexistent-case-id', 'user-hash-1', 'up', '2026-07-29T00:00:00.000Z'),
    ).toThrow();
  });

  it('對不存在的 installation_id 插入 event 會失敗', () => {
    const db = freshDb();
    const repo = new EventRepository(db);

    expect(() =>
      repo.insertPending({
        deliveryId: 'fk-fail-1',
        installationId: 'nonexistent-installation-id',
        eventType: 'workflow_run',
        repoFullName: 'acme/widgets',
        runId: 1,
        runUpdatedAt: '2026-07-29T00:00:00.000Z',
        receivedAt: '2026-07-29T00:00:00.000Z',
        rawBody: Buffer.from('{}'),
      }),
    ).toThrow();
  });
});

describe('FeedbackRepository', () => {
  it('一人一票，重複投票會更新而非新增一列', () => {
    const db = freshDb();
    const instA = seedInstallation(db, 140);
    const eventId = seedEvent(db, instA, 'feedback-1');
    const caseRepo = new CaseRepository(db);
    const created = caseRepo.create({ ...minimalCaseInput(), installationId: instA, eventId });

    const repo = new FeedbackRepository(db);
    repo.upsert(created.id, 'user-hash-1', 'up', '2026-07-29T00:00:00.000Z');
    repo.upsert(created.id, 'user-hash-1', 'down', '2026-07-29T01:00:00.000Z');

    const rows = db
      .prepare<[string, string], { readonly value: string }>(
        `SELECT value FROM feedback WHERE case_id = ? AND slack_user_hash = ?`,
      )
      .all(created.id, 'user-hash-1');
    expect(rows.length).toBe(1);
    expect(rows[0]?.value).toBe('down');
  });
});

describe('InstallationRepository', () => {
  it('upsert 對已存在的 gh_installation_id 更新而非新增', () => {
    const db = freshDb();
    const repo = new InstallationRepository(db);

    const first = repo.upsert({
      ghInstallationId: 999,
      accountLogin: 'old-login',
      accountType: 'User',
      slackTeamId: null,
      slackChannelId: null,
      installedAt: '2026-01-01T00:00:00.000Z',
    });
    const second = repo.upsert({
      ghInstallationId: 999,
      accountLogin: 'new-login',
      accountType: 'Organization',
      slackTeamId: 'T1',
      slackChannelId: 'C1',
      installedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(second.id).toBe(first.id);
    expect(second.account_login).toBe('new-login');
    expect(second.slack_team_id).toBe('T1');
  });

  it('deleteAllData 刪除該 installation 底下的所有相關列', () => {
    const db = freshDb();
    const instA = seedInstallation(db, 150);
    const eventId = seedEvent(db, instA, 'del-1');
    const caseRepo = new CaseRepository(db);
    const created = caseRepo.create({ ...minimalCaseInput(), installationId: instA, eventId });
    new FeedbackRepository(db).upsert(
      created.id,
      'user-hash-del',
      'up',
      '2026-07-29T00:00:00.000Z',
    );
    new LlmUsageRepository(db).record({
      caseId: created.id,
      installationId: instA,
      purpose: 'verdict',
      model: 'claude-haiku-4-5',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      usd: 0.001,
      latencyMs: 500,
      cacheHit: false,
      createdAt: '2026-07-29T00:00:00.000Z',
    });

    const repo = new InstallationRepository(db);
    repo.deleteAllData(instA);

    const remainingCases = db
      .prepare<[string], { readonly n: number }>(
        `SELECT COUNT(*) as n FROM cases WHERE installation_id = ?`,
      )
      .get(instA);
    const remainingEvents = db
      .prepare<[string], { readonly n: number }>(
        `SELECT COUNT(*) as n FROM events WHERE installation_id = ?`,
      )
      .get(instA);
    const remainingFeedback = db
      .prepare<[], { readonly n: number }>(`SELECT COUNT(*) as n FROM feedback`)
      .get();
    const remainingUsage = db
      .prepare<[string], { readonly n: number }>(
        `SELECT COUNT(*) as n FROM llm_usage WHERE installation_id = ?`,
      )
      .get(instA);

    expect(remainingCases?.n).toBe(0);
    expect(remainingEvents?.n).toBe(0);
    expect(remainingFeedback?.n).toBe(0);
    expect(remainingUsage?.n).toBe(0);

    // installations 本身沒有被 deleteAllData 刪除（見 repositories.ts 的說明）
    expect(new InstallationRepository(db).findById(instA)).toBeDefined();
  });
});

describe('LlmUsageRepository', () => {
  it('monthlyUsd 只加總指定月份的花費', () => {
    const db = freshDb();
    const instA = seedInstallation(db, 160);
    const repo = new LlmUsageRepository(db);

    repo.record({
      caseId: null,
      installationId: instA,
      purpose: 'verdict',
      model: 'claude-haiku-4-5',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      usd: 0.002,
      latencyMs: 400,
      cacheHit: false,
      createdAt: '2026-07-05T00:00:00.000Z',
    });
    repo.record({
      caseId: null,
      installationId: instA,
      purpose: 'meme_title',
      model: 'claude-haiku-4-5',
      inputTokens: 20,
      outputTokens: 10,
      cacheReadTokens: 0,
      usd: 0.0005,
      latencyMs: 200,
      cacheHit: false,
      createdAt: '2026-07-20T00:00:00.000Z',
    });
    repo.record({
      caseId: null,
      installationId: instA,
      purpose: 'verdict',
      model: 'claude-haiku-4-5',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      usd: 0.003,
      latencyMs: 400,
      cacheHit: false,
      createdAt: '2026-08-01T00:00:00.000Z',
    });

    const julyTotal = repo.monthlyUsd(instA, '2026-07');
    expect(julyTotal).toBeCloseTo(0.0025, 6);

    const augustTotal = repo.monthlyUsd(instA, '2026-08');
    expect(augustTotal).toBeCloseTo(0.003, 6);
  });
});

describe('createConnection', () => {
  it('對不存在的父目錄會自動建立', async () => {
    const { mkdtempSync, rmSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'prosecutor-db-test-'));
    const nestedPath = join(dir, 'nested', 'deep', 'db.sqlite');

    const db = createConnection(nestedPath);
    db.close();

    expect(existsSync(nestedPath)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
