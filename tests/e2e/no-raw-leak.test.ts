/**
 * no-raw-leak 端到端 canary 測試（P1-08）。
 *
 * `src/logging.test.ts` 已經在 pino 層級證明 `REDACT_PATHS` 與 error serializer
 * 個別有效。這份測試要證明的是**再往上一層**：真正的 webhook handler
 * （`src/routes/webhook.ts`）在它目前所有可達的 log 路徑上，實際跑起來時
 * 也沒有任何一條讓 canary 溜出去——不是「設定對不對」，是「接起來之後還對不對」。
 *
 * `THREAT_MODEL.md` §6 / I1（RAW ZONE 封閉性）：原始 webhook body 只應該活在
 * `rawBody: Buffer` 這個變數裡，一路到 `enqueue()` 為止。任何從 log 可觀測到
 * 這個 Buffer 內容的路徑都是 R2 違規，不管是主流程還是側通道（例外物件、
 * 序列化錯誤、未來有人手滑把 body 掛到 Error 上）。
 *
 * 這裡不改 `src/routes/webhook.ts`、不改 `src/logging.ts`——只加測試。
 * 若這份測試抓到真的洩漏，依規定**停下來回報 Tech Lead，不自行修**。
 *
 * 三個區塊：
 *   1. 用真正的 Fastify + `registerWebhookRoutes` 跑一遍所有目前可達的錯誤/
 *      成功路徑，canary 藏在 webhook body 裡，斷言它不出現在任何一行 log。
 *   2. 逐一走過 `REDACT_PATHS` 的每一條路徑，證明「寫在清單裡」等於「真的被擋下」。
 *   3. 模擬 Octokit `RequestError` 的形狀（P2-11 的 adapter 還沒做，這裡只模擬
 *      外形，不建 adapter），證明 `response.data` 與 `request.headers.authorization`
 *      不會流出去。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import pino from 'pino';
import { buildLoggerOptions, REDACT_PATHS } from '../../src/logging.js';
import {
  registerWebhookRoutes,
  type EnqueueOutcome,
  type IncomingEvent,
} from '../../src/routes/webhook.js';
import { signPayload } from '../../src/security/verify-signature.js';

/** 一個絕不可能自然出現在日誌裡的字串。與 `logging.test.ts` 用不同字串，避免兩份測試互相掩護彼此的 bug。 */
const CANARY = 'CANARY_E2E_7d4f1a9c_NO_RAW_LEAK';

const SECRET = 'no-raw-leak-e2e-secret';

/** 一份形狀正確、但夾帶 canary 的 workflow_run payload。canary 藏在 body 裡，不藏在標頭裡——
 *  deliveryId / eventType / content-type 這些標頭本來就設計成會被記錄（它們是路由 metadata，
 *  不是 R2 說的「原始 log 內容」），把 canary 放在那裡測不出什麼，只會製造假警報。 */
function payloadWithCanary(): Buffer {
  return Buffer.from(
    JSON.stringify({
      action: 'completed',
      workflow_run: {
        id: 1234567890,
        name: 'CI',
        conclusion: 'failure',
        head_branch: 'main',
        head_sha: 'a3f9c1d2e4b5a6978c0d1e2f3a4b5c6d7e8f9a0b',
        updated_at: '2026-07-29T04:33:00Z',
        // 模擬「有人不小心把一段 CI 輸出塞進 payload 欄位」——不管欄位叫什麼名字，
        // 只要它進了 rawBody，就不該從任何 log 路徑滲出去。
        output_excerpt: CANARY,
      },
      repository: { full_name: 'acme/web' },
      installation: { id: 42 },
    }),
    'utf8',
  );
}

interface Harness {
  readonly app: FastifyInstance;
  readonly seen: IncomingEvent[];
  readonly output: () => string;
}

/**
 * 用真正的 `registerWebhookRoutes`（跟 `src/server.ts` 接的是同一個函式）組一個
 * Fastify instance，差別只在 logger 多指定一個 `stream` 把輸出收進陣列——
 * 這跟 `src/logging.test.ts` 的 `captureLogger()` 是同一招，只是這裡接的是
 * 整個 webhook 路由而不是裸的 pino instance。`buildLoggerOptions` 本身
 * （含 REDACT_PATHS 與 error serializer）完全沒動，就是 production 在用的那份。
 */
function buildHarness(
  enqueue: (event: IncomingEvent) => Promise<EnqueueOutcome> | EnqueueOutcome,
  webhookSecret: string = SECRET,
): Harness {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString('utf8'));
      cb();
    },
  });
  const seen: IncomingEvent[] = [];
  const app = Fastify({
    logger: { ...buildLoggerOptions('trace', false), stream: sink },
    bodyLimit: 512 * 1024,
  });
  registerWebhookRoutes(app, {
    webhookSecret,
    enqueue: (event) => {
      seen.push(event);
      return enqueue(event);
    },
  });
  return { app, seen, output: () => chunks.join('') };
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

describe('webhook e2e —— canary 不會從任何目前可達的 log 路徑滲出', () => {
  it('簽章錯誤（401）：reason 進 log，但 body 裡的 canary 不會', async () => {
    const { app, output } = buildHarness(() => 'accepted');
    current = app;
    const body = payloadWithCanary();

    const res = await post(app, body, {
      'x-hub-signature-256': signPayload(body, 'wrong-secret'),
      'x-github-delivery': 'sig-fail-canary',
      'x-github-event': 'workflow_run',
    });

    expect(res.statusCode).toBe(401);
    expect(output()).not.toContain(CANARY);
  });

  it('非 JSON content-type（415）：只記 content-type 標頭，不記 body', async () => {
    const { app, output } = buildHarness(() => 'accepted');
    current = app;
    // body 本身就是 canary——不是合法 JSON，走的是「content-type 不是 application/json」
    // 那個分支，這個分支只 log `req.headers['content-type']`，不該碰到 body。
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: { 'content-type': 'text/plain' },
      payload: CANARY,
    });

    expect(res.statusCode).toBe(415);
    expect(output()).not.toContain(CANARY);
  });

  it('簽章正確但 body 不是合法 JSON（handler 本來就不 parse，仍驗一次不外洩）', async () => {
    const { app, seen, output } = buildHarness(() => 'accepted');
    current = app;
    // content-type 是 application/json，但內容根本不是 JSON——只有 canary 本身。
    // `registerWebhookRoutes` 的自訂 parser 不做任何 JSON.parse，簽章驗過就直接
    // 把 raw bytes 交給 enqueue，所以這應該是 200 accepted，而不是任何形式的錯誤。
    const body = Buffer.from(CANARY, 'utf8');

    const res = await post(app, body, {
      'x-hub-signature-256': signPayload(body, SECRET),
      'x-github-delivery': 'malformed-body-canary',
      'x-github-event': 'workflow_run',
    });

    expect(res.statusCode).toBe(200);
    expect(seen[0]?.rawBody.toString('utf8')).toBe(CANARY); // enqueue 確實收到了原始內容
    expect(output()).not.toContain(CANARY); // 但一行都不該進 log
  });

  it('已驗簽但缺少必要標頭（200 ignored）：body 裡的 canary 不外洩', async () => {
    const { app, output } = buildHarness(() => 'accepted');
    current = app;
    const body = payloadWithCanary();

    const res = await post(app, body, {
      'x-hub-signature-256': signPayload(body, SECRET),
      'x-github-event': 'workflow_run',
      // 故意不給 x-github-delivery
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ignored' });
    expect(output()).not.toContain(CANARY);
  });

  it('未訂閱的事件類型（200 skipped）：body 裡的 canary 不外洩', async () => {
    const { app, output } = buildHarness(() => 'accepted');
    current = app;
    const body = payloadWithCanary();

    const res = await post(app, body, {
      'x-hub-signature-256': signPayload(body, SECRET),
      'x-github-delivery': 'unsubscribed-canary',
      'x-github-event': 'push',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'skipped' });
    expect(output()).not.toContain(CANARY);
  });

  it('enqueue 拋錯（503）：即使錯誤物件夾帶 canary 屬性也不外洩，訊息本身仍可讀', async () => {
    const { app, output } = buildHarness(() => {
      // 模擬一個現實可能發生的失誤：DB 層把整個 body 掛到 Error 的自訂屬性上
      // 方便自己除錯，卻忘了那條 Error 最後會被 `req.log.error({ err, ... })` 記下來。
      // `serializeError` 只留 name/message/stack/code/status，這類自訂屬性本來就
      // 不該被序列化——這裡是在 webhook.ts 的真實 catch 路徑上驗證這件事，
      // 不是在 logging.ts 的單元測試裡驗證。
      throw Object.assign(new Error('insert into events failed: UNIQUE constraint'), {
        debugContext: CANARY,
        rawBody: Buffer.from(CANARY, 'utf8'),
      });
    });
    current = app;
    const body = payloadWithCanary();

    const res = await post(app, body, {
      'x-hub-signature-256': signPayload(body, SECRET),
      'x-github-delivery': 'enqueue-throws-canary',
      'x-github-event': 'workflow_run',
    });

    expect(res.statusCode).toBe(503);
    const out = output();
    expect(out).not.toContain(CANARY);
    expect(out).toContain('insert into events failed'); // message 要留著，否則沒法除錯
  });

  it('佇列不可用（503，無例外物件）：body 裡的 canary 不外洩', async () => {
    const { app, output } = buildHarness(() => 'unavailable');
    current = app;
    const body = payloadWithCanary();

    const res = await post(app, body, {
      'x-hub-signature-256': signPayload(body, SECRET),
      'x-github-delivery': 'unavailable-canary',
      'x-github-event': 'workflow_run',
    });

    expect(res.statusCode).toBe(503);
    expect(output()).not.toContain(CANARY);
  });

  it('完全成功的路徑（200 accepted）：即使一切正常，body 裡的 canary 也不該進 log', async () => {
    const { app, output } = buildHarness(() => 'accepted');
    current = app;
    const body = payloadWithCanary();

    const res = await post(app, body, {
      'x-hub-signature-256': signPayload(body, SECRET),
      'x-github-delivery': 'accepted-canary',
      'x-github-event': 'workflow_run',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'accepted' });
    expect(output()).not.toContain(CANARY);
  });
});

// ── REDACT_PATHS 完整性：不只是「清單裡有」，是「真的擋得住」──────────────────

/** 建一個把輸出收進陣列的裸 pino logger，跟 `logging.test.ts` 同一招。 */
function captureLogger(): { logger: pino.Logger; output: () => string } {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString('utf8'));
      cb();
    },
  });
  const logger = pino(buildLoggerOptions('trace', false), sink);
  return { logger, output: () => chunks.join('') };
}

/** 把 `req.headers["x-hub-signature-256"]` 這種路徑拆成 `['req','headers','x-hub-signature-256']`。 */
function pathSegments(path: string): string[] {
  const segments: string[] = [];
  const re = /\[["']([^"']+)["']\]|([^.[\]]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(path)) !== null) {
    const segment = match[1] ?? match[2];
    if (segment === undefined) {
      throw new Error(`無法解析 REDACT_PATHS 路徑片段：${path}`);
    }
    segments.push(segment);
  }
  return segments;
}

/**
 * 依照 `REDACT_PATHS` 的字面路徑，組出一個在該路徑上放了 canary 的 log payload。
 * `*.` 開頭的萬用字元路徑會包一層任意鍵名（`probe`）——這正是萬用字元宣稱要
 * 涵蓋的情境：「巢狀一層、鍵名不固定」。
 */
function payloadForPath(path: string, value: string): Record<string, unknown> {
  const isWildcard = path.startsWith('*.');
  const segments = pathSegments(isWildcard ? path.slice(2) : path);

  let node: unknown = value;
  for (let i = segments.length - 1; i >= 0; i--) {
    const key = segments[i];
    if (key === undefined) throw new Error(`無法解析 REDACT_PATHS 路徑片段：${path}`);
    node = { [key]: node };
  }

  return (isWildcard ? { probe: node } : node) as Record<string, unknown>;
}

describe('REDACT_PATHS —— 逐條路徑證明真的擋得住 canary（不只是清單裡有寫）', () => {
  it.each(REDACT_PATHS)('%s', (path) => {
    const { logger, output } = captureLogger();
    logger.info(payloadForPath(path, CANARY), 'REDACT_PATHS 覆蓋率探測');
    expect(output()).not.toContain(CANARY);
  });

  it('涵蓋 THREAT_MODEL.md §6 列出的所有原始/清洗中內容欄位家族', () => {
    // 這幾個是 logging.ts 註解裡明講「原始與清洗中的 log 內容」那組——
    // 用 THREAT_MODEL.md §6 的用詞重新列一次，確保它們沒有被靜默移除。
    const rawContentFields = ['rawLog', 'logContent', 'errorWindow', 'sanitized', 'lines'];
    for (const field of rawContentFields) {
      expect(REDACT_PATHS, `缺少裸欄位 '${field}'`).toContain(field);
      expect(REDACT_PATHS, `缺少萬用字元 '*.${field}'`).toContain(`*.${field}`);
    }
  });

  it('涵蓋憑證欄位家族', () => {
    const credentialFields = ['privateKey', 'token', 'apiKey', 'secret'];
    for (const field of credentialFields) {
      expect(REDACT_PATHS, `缺少裸欄位 '${field}'`).toContain(field);
      expect(REDACT_PATHS, `缺少萬用字元 '*.${field}'`).toContain(`*.${field}`);
    }
  });

  it('涵蓋會攜帶憑證的請求標頭', () => {
    for (const path of [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-hub-signature-256"]',
      'request.headers.authorization',
    ]) {
      expect(REDACT_PATHS, `缺少 '${path}'`).toContain(path);
    }
  });

  it('涵蓋 Octokit 錯誤物件會塞整包回應進來的欄位', () => {
    for (const path of [
      'err.response.data',
      'error.response.data',
      '*.response.data',
      'err.request.headers.authorization',
    ]) {
      expect(REDACT_PATHS, `缺少 '${path}'`).toContain(path);
    }
  });
});

// ── Octokit RequestError 形狀：response.data 與 authorization 標頭剝除 ──────
//
// P2-11（Octokit 錯誤正規化層）還沒做，這裡刻意不建那個 adapter，只模擬
// `@octokit/request-error` 的 `RequestError` 外形（它本身是 `Error` 的子類別，
// 帶 `status` / `response` / `request`），確認 `serializeError` 現在就已經
// 讓這個形狀安全，而不是要等到 Phase 2 才有保障。

describe('Octokit RequestError 形狀 —— response.data 與 authorization 標頭被剝除', () => {
  it('直接送進 error serializer：response.data 與 request.headers.authorization 都不見了，status 還在', () => {
    const { logger, output } = captureLogger();
    // RequestError 真的是 Error 的子類別（見 @octokit/request-error），
    // 所以用 Object.assign(new Error(...), {...}) 才是忠實的形狀模擬，
    // 不是隨便一個 plain object。
    const err = Object.assign(new Error('Not Found'), {
      name: 'HttpError',
      status: 404,
      response: {
        url: 'https://api.github.com/repos/acme/web/actions/jobs/1/logs',
        status: 404,
        headers: {},
        data: CANARY,
      },
      request: {
        method: 'GET',
        url: 'https://api.github.com/repos/acme/web/actions/jobs/1/logs',
        headers: { authorization: `token ${CANARY}` },
      },
    });

    logger.error({ err }, '抓 log 失敗');

    const out = output();
    expect(out).not.toContain(CANARY);
    expect(out).toContain('404'); // status 要留著，否則沒法判斷要不要重試
    expect(out).toContain('HttpError');
  });

  it('端到端：enqueue 拋出 Octokit 形狀的錯誤，走真正的 webhook 503 路徑，canary 依然不外洩', async () => {
    const { app, output } = buildHarness(() => {
      throw Object.assign(new Error('Not Found'), {
        name: 'HttpError',
        status: 404,
        response: { data: CANARY },
        request: { headers: { authorization: `token ${CANARY}` } },
      });
    });
    current = app;
    const body = payloadWithCanary();

    const res = await post(app, body, {
      'x-hub-signature-256': signPayload(body, SECRET),
      'x-github-delivery': 'octokit-shape-canary',
      'x-github-event': 'workflow_run',
    });

    expect(res.statusCode).toBe(503);
    expect(output()).not.toContain(CANARY);
  });

  it('即使拋出的不是 Error 實例（純物件），依然安全（NonError 分支不會保留任何屬性）', () => {
    const { logger, output } = captureLogger();
    // 防禦性案例：萬一某處直接 throw 一個長得像 RequestError 的 plain object
    // （不是真正的 Error 子類別），serializer 的 NonError 分支必須一樣安全。
    const fakeErr = {
      name: 'HttpError',
      status: 404,
      response: { data: CANARY },
      request: { headers: { authorization: CANARY } },
    };

    logger.error({ err: fakeErr }, '抓 log 失敗（非 Error 拋出值）');

    expect(output()).not.toContain(CANARY);
  });
});
