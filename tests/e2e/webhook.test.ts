/**
 * 假 webhook 端到端測試。
 *
 * 對應 **Gate P1**：「假 webhook 通過驗簽並回 200 < 3 秒」。
 *
 * 這裡不用真的網路——`app.inject()` 走完整的 Fastify 生命週期
 * （content-type parser、路由、handler、序列化），但不開 socket。
 * 這正是我們要測的部分：raw body 是否真的被原樣交到驗簽函式手上。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/server.js';
import { signPayload } from '../../src/security/verify-signature.js';
import type { EnqueueOutcome, IncomingEvent } from '../../src/routes/webhook.js';
import { loadEnv } from '../../src/config/env.js';

const SECRET = 'e2e-webhook-secret';

/** 一份最小但形狀正確的 workflow_run.completed / failure payload。 */
const PAYLOAD = {
  action: 'completed',
  workflow_run: {
    id: 1234567890,
    name: 'CI',
    conclusion: 'failure',
    head_branch: 'main',
    head_sha: 'a3f9c1d2e4b5a6978c0d1e2f3a4b5c6d7e8f9a0b',
    updated_at: '2026-07-29T04:33:00Z',
  },
  repository: { full_name: 'acme/web' },
  installation: { id: 42 },
};

function makeEnv() {
  return loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    GITHUB_WEBHOOK_SECRET: SECRET,
  });
}

interface Harness {
  readonly app: FastifyInstance;
  readonly seen: IncomingEvent[];
}

function build(outcome: EnqueueOutcome = 'accepted'): Harness {
  const seen: IncomingEvent[] = [];
  const app = buildServer({
    env: makeEnv(),
    enqueue: (event) => {
      seen.push(event);
      return outcome;
    },
  });
  return { app, seen };
}

function post(app: FastifyInstance, body: Buffer, headers: Record<string, string>) {
  return app.inject({
    method: 'POST',
    url: '/webhooks/github',
    headers: { 'content-type': 'application/json', ...headers },
    payload: body,
  });
}

let current: FastifyInstance | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

describe('POST /webhooks/github', () => {
  it('Gate P1：合法簽章 → 200，且遠低於 3 秒', async () => {
    const { app, seen } = build();
    current = app;
    const body = Buffer.from(JSON.stringify(PAYLOAD), 'utf8');

    const started = performance.now();
    const res = await post(app, body, {
      'x-hub-signature-256': signPayload(body, SECRET),
      'x-github-delivery': '11111111-2222-3333-4444-555555555555',
      'x-github-event': 'workflow_run',
    });
    const elapsedMs = performance.now() - started;

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'accepted' });
    expect(elapsedMs).toBeLessThan(3000);
    // 實務上應該遠快於此。留一個更嚴格的斷言當作效能回歸的哨兵。
    expect(elapsedMs).toBeLessThan(500);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.deliveryId).toBe('11111111-2222-3333-4444-555555555555');
    expect(seen[0]?.eventType).toBe('workflow_run');
  });

  it('交給 enqueue 的是原始位元組，不是重新序列化的結果', async () => {
    const { app, seen } = build();
    current = app;
    // 刻意用非正規的空白排版。若中途被 parse 再 stringify，這些空白會消失。
    const body = Buffer.from('{"action":  "completed",\n  "zz": 1, "aa": 2}', 'utf8');

    const res = await post(app, body, {
      'x-hub-signature-256': signPayload(body, SECRET),
      'x-github-delivery': 'raw-bytes-check',
      'x-github-event': 'workflow_run',
    });

    expect(res.statusCode).toBe(200);
    expect(seen[0]?.rawBody.equals(body)).toBe(true);
  });

  it('簽章錯誤 → 401，且不呼叫 enqueue', async () => {
    const { app, seen } = build();
    current = app;
    const body = Buffer.from(JSON.stringify(PAYLOAD), 'utf8');

    const res = await post(app, body, {
      'x-hub-signature-256': signPayload(body, 'wrong-secret'),
      'x-github-delivery': 'bad-sig',
      'x-github-event': 'workflow_run',
    });

    expect(res.statusCode).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('缺少簽章標頭 → 401（不是略過驗簽）', async () => {
    const { app, seen } = build();
    current = app;
    const body = Buffer.from(JSON.stringify(PAYLOAD), 'utf8');

    const res = await post(app, body, {
      'x-github-delivery': 'no-sig',
      'x-github-event': 'workflow_run',
    });

    expect(res.statusCode).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('401 的回應內容不透露失敗原因', async () => {
    const { app } = build();
    current = app;
    const body = Buffer.from(JSON.stringify(PAYLOAD), 'utf8');

    const missing = await post(app, body, { 'x-github-event': 'workflow_run' });
    const wrong = await post(app, body, {
      'x-hub-signature-256': signPayload(body, 'nope'),
      'x-github-event': 'workflow_run',
    });

    // 兩種不同的失敗必須看起來完全一樣，否則等於告訴攻擊者他離成功多遠。
    expect(missing.statusCode).toBe(wrong.statusCode);
    expect(missing.body).toBe(wrong.body);
  });

  it('body 被竄改 → 401', async () => {
    const { app } = build();
    current = app;
    const original = Buffer.from(JSON.stringify(PAYLOAD), 'utf8');
    const sig = signPayload(original, SECRET);
    const tampered = Buffer.from(
      JSON.stringify({ ...PAYLOAD, repository: { full_name: 'evil/repo' } }),
      'utf8',
    );

    const res = await post(app, tampered, {
      'x-hub-signature-256': sig,
      'x-github-delivery': 'tampered',
      'x-github-event': 'workflow_run',
    });

    expect(res.statusCode).toBe(401);
  });

  it('重複的 delivery → 200 且狀態為 duplicate（GitHub 不該重送）', async () => {
    const { app } = build('duplicate');
    current = app;
    const body = Buffer.from(JSON.stringify(PAYLOAD), 'utf8');

    const res = await post(app, body, {
      'x-hub-signature-256': signPayload(body, SECRET),
      'x-github-delivery': 'seen-before',
      'x-github-event': 'workflow_run',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'duplicate' });
  });

  it('queue 不可用 → 503（讓 GitHub 重送，不靜默丟事件）', async () => {
    const { app } = build('unavailable');
    current = app;
    const body = Buffer.from(JSON.stringify(PAYLOAD), 'utf8');

    const res = await post(app, body, {
      'x-hub-signature-256': signPayload(body, SECRET),
      'x-github-delivery': 'queue-down',
      'x-github-event': 'workflow_run',
    });

    expect(res.statusCode).toBe(503);
  });

  it('enqueue 拋錯 → 503，不會變成 500 或靜默 200', async () => {
    const app = buildServer({
      env: makeEnv(),
      enqueue: () => {
        throw new Error('database is on fire');
      },
    });
    current = app;
    const body = Buffer.from(JSON.stringify(PAYLOAD), 'utf8');

    const res = await post(app, body, {
      'x-hub-signature-256': signPayload(body, SECRET),
      'x-github-delivery': 'db-down',
      'x-github-event': 'workflow_run',
    });

    expect(res.statusCode).toBe(503);
  });

  it('未注入 enqueue 時回 503，不假裝收下（R4）', async () => {
    const app = buildServer({ env: makeEnv() });
    current = app;
    const body = Buffer.from(JSON.stringify(PAYLOAD), 'utf8');

    const res = await post(app, body, {
      'x-hub-signature-256': signPayload(body, SECRET),
      'x-github-delivery': 'no-queue',
      'x-github-event': 'workflow_run',
    });

    expect(res.statusCode).toBe(503);
  });

  it('已驗簽但缺 delivery 標頭 → 200 ignored（不讓 GitHub 無謂重送）', async () => {
    const { app, seen } = build();
    current = app;
    const body = Buffer.from(JSON.stringify(PAYLOAD), 'utf8');

    const res = await post(app, body, {
      'x-hub-signature-256': signPayload(body, SECRET),
      'x-github-event': 'workflow_run',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ignored' });
    expect(seen).toHaveLength(0);
  });

  it('簽章標頭重複出現時視為缺失 → 401（不猜測意圖）', async () => {
    const { app } = build();
    current = app;
    const body = Buffer.from(JSON.stringify(PAYLOAD), 'utf8');
    const good = signPayload(body, SECRET);

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': [good, signPayload(body, 'other')],
        'x-github-delivery': 'dup-header',
        'x-github-event': 'workflow_run',
      },
      payload: body,
    });

    expect(res.statusCode).toBe(401);
  });

  it('未訂閱的事件類型 → 200 skipped，不進佇列（redteam P1-09 #4）', async () => {
    const { app, seen } = build();
    current = app;
    const body = Buffer.from(JSON.stringify(PAYLOAD), 'utf8');

    // 簽章正確，但這是我們沒訂閱的事件。放進佇列會佔用該 installation 的
    // 處理配額，稀釋掉 per-installation rate limit。
    const res = await post(app, body, {
      'x-hub-signature-256': signPayload(body, SECRET),
      'x-github-delivery': 'unsubscribed-event',
      'x-github-event': 'push',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'skipped' });
    expect(seen).toHaveLength(0);
  });

  it.each(['workflow_run', 'installation', 'installation_repositories', 'ping'])(
    '訂閱的事件類型 %s 會進佇列',
    async (eventType) => {
      const { app, seen } = build();
      current = app;
      const body = Buffer.from(JSON.stringify(PAYLOAD), 'utf8');

      const res = await post(app, body, {
        'x-hub-signature-256': signPayload(body, SECRET),
        'x-github-delivery': `sub-${eventType}`,
        'x-github-event': eventType,
      });

      expect(res.statusCode).toBe(200);
      expect(seen).toHaveLength(1);
    },
  );

  it('事件過濾發生在驗簽之後——沒有簽章就沒有機會走到過濾', async () => {
    const { app } = build();
    current = app;
    const body = Buffer.from(JSON.stringify(PAYLOAD), 'utf8');

    // 未訂閱事件 + 錯誤簽章：必須回 401 而不是 200 skipped，
    // 否則等於免費告訴攻擊者我們訂閱了哪些事件。
    const res = await post(app, body, {
      'x-hub-signature-256': signPayload(body, 'wrong'),
      'x-github-delivery': 'unsub-badsig',
      'x-github-event': 'push',
    });

    expect(res.statusCode).toBe(401);
  });

  it('超過 body 上限 → 413，且不計算 HMAC（redteam P1-09 #2）', async () => {
    const { app, seen } = build();
    current = app;
    // 上限是 512KB。同步的 HMAC 計算是 event loop 阻塞來源，
    // 攻擊者不需要知道 secret 就能用大 body 拖慢全站。
    const huge = Buffer.alloc(600 * 1024, 0x61);

    const res = await post(app, huge, {
      'x-hub-signature-256': signPayload(huge, SECRET),
      'x-github-delivery': 'too-big',
      'x-github-event': 'workflow_run',
    });

    expect(res.statusCode).toBe(413);
    expect(seen).toHaveLength(0);
  });

  it('連續 20 次合法請求的平均延遲仍遠低於預算', async () => {
    const { app } = build();
    current = app;
    const body = Buffer.from(JSON.stringify(PAYLOAD), 'utf8');
    const sig = signPayload(body, SECRET);

    const started = performance.now();
    for (let i = 0; i < 20; i++) {
      const res = await post(app, body, {
        'x-hub-signature-256': sig,
        'x-github-delivery': `burst-${String(i)}`,
        'x-github-event': 'workflow_run',
      });
      expect(res.statusCode).toBe(200);
    }
    const avgMs = (performance.now() - started) / 20;
    expect(avgMs).toBeLessThan(100);
  });
});

describe('健康檢查', () => {
  it('/healthz 回 200；/readyz 在未就緒時回 503', async () => {
    const app = buildServer({ env: makeEnv(), isReady: () => false });
    current = app;

    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(503);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
