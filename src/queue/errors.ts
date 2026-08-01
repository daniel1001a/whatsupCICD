/**
 * `events.last_error` 的遮罩摘要工具。
 *
 * ⚠️ 這不是 R1 的 sanitizer（那是獨立模組，專門處理 CI log 內容，見
 * `CLAUDE.md`「分派規則」——sanitizer 一律由 Tech Lead 親自實作，不外派、
 * 本任務不得碰）。這裡處理的是完全不同的東西：`EventHandler` 拋出的
 * JS `Error`。它不會是使用者的 CI log，但仍可能意外夾帶 stack trace、
 * 檔案路徑之類不該落地的內容——這正是 R4「masked」二字的字面意思。
 *
 * 因此只取 `name` + `message`，丟掉 `stack`（與任何其他自訂屬性），
 * 攤平成單行，並限長，才寫進 `events.last_error`。
 */

/** `events.last_error` 是 TEXT 欄位，沒有 DB 層長度限制，但過長的摘要
 * 對「摘要」這個用途沒有意義，也徒增落地內容的體積。 */
const MAX_SUMMARY_LENGTH = 500;

/**
 * 把任意拋出值濃縮成一行遮罩後的錯誤摘要。
 *
 * - `Error` 執行個體：只取 `name: message`，不含 `stack`。
 * - 其他任意拋出值（`throw 'x'`、`throw { code: 1 }` 等）：`String()` 轉換，
 *   同樣不假設其結構、不遍歷屬性——避免意外序列化出攜帶敏感內容的欄位。
 * - 換行與連續空白一律攤平成單一空格，確保 `last_error` 恆為單行
 *   （多行文字在 log 檢視工具裡容易被誤讀成「這是完整的錯誤內容」）。
 */
export function summarizeError(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const oneLine = raw.replace(/\s+/g, ' ').trim();

  return oneLine.length > MAX_SUMMARY_LENGTH ? `${oneLine.slice(0, MAX_SUMMARY_LENGTH)}…` : oneLine;
}
