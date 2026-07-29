/**
 * 結構化日誌（pino）。
 *
 * 這個模組是 R2「原始 log 不落地」的一道防線，不只是格式設定。
 *
 * `THREAT_MODEL.md` §6 指出：原始 CI log 最可能的外洩路徑不是主要流程，
 * 而是**側通道**——某個人不小心把整個 pipeline context 丟進 logger，
 * 或某個例外的 message 夾帶了 log 內容。因此：
 *
 *   1. `redact` 明列所有已知會攜帶敏感內容的路徑，一律替換成 `[redacted]`。
 *   2. 一組自訂 serializer，讓 Error 只留下 name/message/stack 的安全子集，
 *      並剝除 Octokit `RequestError` 上的 `response.data` 與
 *      `request.headers.authorization`。
 *   3. `no-console` 由 ESLint 強制——console 繞過本模組的所有防護。
 */
import pino, { type Logger, type LoggerOptions } from 'pino';

/**
 * 絕不可被序列化的欄位路徑。
 *
 * 新增管線欄位時，若它可能攜帶未遮罩的內容，**必須**加進這個清單。
 * `P2-11` 的 canary string 測試會跨所有錯誤路徑驗證這件事。
 */
export const REDACT_PATHS = [
  // 原始與清洗中的 log 內容
  'rawLog',
  '*.rawLog',
  'logContent',
  '*.logContent',
  'errorWindow',
  '*.errorWindow',
  'sanitized',
  '*.sanitized',
  'lines',
  '*.lines',

  // 憑證
  //
  // ⚠️ 裸欄位名與 `*.` 萬用字元版**必須成對出現**。pino 的 `*.x` 只匹配巢狀一層，
  //    不匹配頂層的 `x`——只寫萬用字元版會讓 `logger.info({ token })` 原封不動地印出來。
  //    這個坑是被 logging.test.ts 抓到的，不是推理出來的；改動這份清單時請一併更新測試。
  'privateKey',
  'token',
  'apiKey',
  'secret',
  '*.privateKey',
  '*.token',
  '*.apiKey',
  '*.secret',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-hub-signature-256"]',
  'request.headers.authorization',
  'err.request.headers.authorization',

  // Octokit 的錯誤物件會把整個回應塞進來
  'err.response.data',
  'error.response.data',
  '*.response.data',
] as const;

/** Error → 只保留安全子集。絕不序列化 `cause` 鏈以外的任意屬性。 */
function serializeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { type: 'NonError', message: String(err) };
  return {
    type: err.name,
    message: err.message,
    stack: err.stack,
    ...('code' in err && typeof err.code === 'string' ? { code: err.code } : {}),
    ...('status' in err && typeof err.status === 'number' ? { status: err.status } : {}),
  };
}

export function buildLoggerOptions(level: string, pretty: boolean): LoggerOptions {
  return {
    level,
    redact: { paths: [...REDACT_PATHS], censor: '[redacted]' },
    serializers: { err: serializeError, error: serializeError },
    base: { service: 'build-failure-prosecutor' },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, singleLine: false } } }
      : {}),
  };
}

export function createLogger(level = 'info', pretty = false): Logger {
  return pino(buildLoggerOptions(level, pretty));
}

export type { Logger };
