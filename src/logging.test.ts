/**
 * 日誌洩漏防護測試（P1-08）。
 *
 * 這不是「logger 格式對不對」的測試，是 **R2「原始 log 不落地」的回歸測試**。
 *
 * `THREAT_MODEL.md` §6 指出：原始 CI log 最可能的外洩路徑不是主流程，而是側通道——
 * 有人把整個 pipeline context 丟進 logger、或某個例外的 message 夾帶了 log 內容，
 * 然後那行 JSON 被平台收走、進了備份、進了 error tracker。
 *
 * 手法：往每個可疑欄位塞一個 **canary 字串**，把 logger 的輸出攔下來，
 * 斷言 canary 不出現在任何一個位元組裡。canary 出現 = 有一條外洩路徑。
 */
import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
import { buildLoggerOptions, REDACT_PATHS } from './logging.js';

/** 一個絕不可能自然出現在日誌裡的字串。 */
const CANARY = 'CANARY_LEAK_9f3a2b7c_DO_NOT_LOG';

/** 建一個把輸出收進陣列的 logger（不經過 transport，才拿得到原始 JSON）。 */
function captureLogger(): { logger: pino.Logger; output: () => string } {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString('utf8'));
      cb();
    },
  });
  // pretty transport 會另起 worker，測試裡拿不到輸出，因此固定 pretty=false。
  const logger = pino(buildLoggerOptions('trace', false), sink);
  return { logger, output: () => chunks.join('') };
}

describe('pino redaction —— R2 側通道防護', () => {
  it.each([
    ['rawLog', { rawLog: CANARY }],
    ['logContent', { logContent: CANARY }],
    ['errorWindow', { errorWindow: CANARY }],
    ['sanitized', { sanitized: CANARY }],
    ['lines', { lines: CANARY }],
    ['巢狀 rawLog', { ctx: { rawLog: CANARY } }],
    ['巢狀 errorWindow', { job: { errorWindow: CANARY } }],
    ['token', { token: CANARY }],
    ['apiKey', { apiKey: CANARY }],
    ['secret', { secret: CANARY }],
    ['privateKey', { privateKey: CANARY }],
    ['巢狀 response.data', { upstream: { response: { data: CANARY } } }],
  ])('%s 不會被序列化', (_name, payload) => {
    const { logger, output } = captureLogger();
    logger.info(payload, '測試訊息');
    expect(output()).not.toContain(CANARY);
    expect(output()).toContain('[redacted]');
  });

  it('請求標頭中的 authorization 與 cookie 被遮蔽', () => {
    const { logger, output } = captureLogger();
    logger.info(
      { req: { headers: { authorization: `Bearer ${CANARY}`, cookie: `session=${CANARY}` } } },
      'incoming',
    );
    expect(output()).not.toContain(CANARY);
  });

  it('X-Hub-Signature-256 不進日誌（簽章本身不是秘密，但沒有理由留存）', () => {
    const { logger, output } = captureLogger();
    logger.info({ req: { headers: { 'x-hub-signature-256': `sha256=${CANARY}` } } }, 'incoming');
    expect(output()).not.toContain(CANARY);
  });
});

describe('Error serializer —— 例外是最容易被忽略的洩漏路徑', () => {
  it('一般 Error 只保留安全子集，不序列化任意自訂屬性', () => {
    const { logger, output } = captureLogger();
    const err = Object.assign(new Error('管線失敗'), {
      // 有人（未來的我們）很可能把上下文掛在 Error 上。這必須不進日誌。
      rawLog: CANARY,
      errorWindow: CANARY,
      internalState: { buffer: CANARY },
    });

    logger.error({ err }, '處理失敗');

    const out = output();
    expect(out).not.toContain(CANARY);
    expect(out).toContain('管線失敗'); // message 本身要留著，否則沒法除錯
    expect(out).toContain('Error');
  });

  it('剝除 Octokit RequestError 的 response.data 與 authorization 標頭', () => {
    const { logger, output } = captureLogger();
    // 模擬 Octokit 的 RequestError 形狀：它同時帶著整個回應內容與請求標頭。
    const err = Object.assign(new Error('HTTP 404'), {
      name: 'HttpError',
      status: 404,
      response: { data: { log: CANARY }, url: 'https://api.github.com/...' },
      request: { headers: { authorization: `token ${CANARY}` } },
    });

    logger.error({ err }, '抓 log 失敗');

    const out = output();
    expect(out).not.toContain(CANARY);
    expect(out).toContain('HTTP 404');
    expect(out).toContain('404'); // status 要留著，它決定我們怎麼處理
  });

  it('非 Error 的拋出值也不會夾帶內容', () => {
    const { logger, output } = captureLogger();
    logger.error({ err: { weird: CANARY } }, '奇怪的拋出值');
    expect(output()).not.toContain(CANARY);
  });

  it('Error 的 cause 鏈不被序列化（cause 常常掛著原始上下文）', () => {
    const { logger, output } = captureLogger();
    const inner = Object.assign(new Error('底層失敗'), { rawLog: CANARY });
    const outer = new Error('外層失敗', { cause: inner });

    logger.error({ err: outer }, '巢狀失敗');

    const out = output();
    expect(out).not.toContain(CANARY);
    expect(out).toContain('外層失敗');
  });
});

describe('REDACT_PATHS 的完整性', () => {
  it('涵蓋所有已知會攜帶 log 內容的欄位名', () => {
    // 這個清單是刻意重複寫一次的。新增管線欄位時，若忘了更新 logging.ts，
    // 這個測試會失敗——它的作用是強迫下一個人回來看 THREAT_MODEL.md §6。
    const mustCover = [
      'rawLog',
      'logContent',
      'errorWindow',
      'sanitized',
      'lines',
      'req.headers.authorization',
      'req.headers.cookie',
      'request.headers.authorization',
    ];
    for (const path of mustCover) {
      expect(REDACT_PATHS).toContain(path);
    }
  });

  it('每個裸欄位名都有對應的萬用字元版本，反之亦然', () => {
    // pino 的 `*.x` **只匹配巢狀一層，不匹配頂層的 `x`**。兩者必須成對出現，
    // 否則 `logger.info({ token })` 這種最自然的寫法會直接印出秘密。
    // 這條規則是實測抓到的，不是推理出來的。
    const mustPair = [
      'rawLog',
      'logContent',
      'errorWindow',
      'sanitized',
      'lines',
      'privateKey',
      'token',
      'apiKey',
      'secret',
    ];
    for (const name of mustPair) {
      expect(REDACT_PATHS, `缺少裸欄位版 '${name}'`).toContain(name);
      expect(REDACT_PATHS, `缺少萬用字元版 '*.${name}'`).toContain(`*.${name}`);
    }
  });
});
