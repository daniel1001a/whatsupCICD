/**
 * GitHub webhook HMAC-SHA256 驗簽。
 *
 * 對應 `THREAT_MODEL.md` §5「偽造簽章」。這個檔案是整個系統的信任邊界——
 * 通過這裡的位元組會被當成 GitHub 說的話。
 *
 * 三個不可妥協的性質：
 *
 *   1. **對 raw bytes 驗簽，在任何 JSON parse 之前。**
 *      body parser 會做正規化（重排鍵、改變空白、統一數字表示），
 *      重新序列化後的位元組與 GitHub 簽的位元組不同，驗簽必然失敗——
 *      更糟的情況是「大部分時候會過」，於是有人加上寬鬆處理來繞過它。
 *
 *   2. **timing-safe 比較。** 逐字元的 `===` 會提早回傳，
 *      攻擊者能以回應時間逐位元組還原正確簽章。
 *
 *   3. **缺簽章 = 拒絕，不是略過。** 「沒有簽章就不驗」是這類程式碼
 *      最常見的致命寫法。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** 驗簽失敗的原因。回給用戶端時一律只說「invalid signature」，這個細分只進日誌。 */
export type SignatureFailure =
  | 'missing_header'
  | 'malformed_header'
  | 'unsupported_algorithm'
  | 'length_mismatch'
  | 'mismatch'
  | 'secret_not_configured';

export type VerifyResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: SignatureFailure };

const PREFIX = 'sha256=';
/** SHA-256 的十六進位摘要固定 64 字元。 */
const HEX_DIGEST_LENGTH = 64;

/**
 * 驗證 `X-Hub-Signature-256`。
 *
 * @param rawBody GitHub 送來的**原始位元組**。不可是 parse 後再序列化的結果。
 * @param header  `X-Hub-Signature-256` 標頭值，形如 `sha256=<64 hex>`。
 * @param secret  webhook secret，從環境變數注入。
 */
export function verifyGitHubSignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
): VerifyResult {
  // 空 secret 代表設定錯誤。此時若回傳 ok 就等於完全關閉驗簽——
  // fail-closed：拒絕，並用一個可辨識的原因讓維運看得出是設定問題而非攻擊。
  if (secret.length === 0) return { ok: false, reason: 'secret_not_configured' };

  if (header === undefined || header.length === 0) return { ok: false, reason: 'missing_header' };

  if (!header.startsWith(PREFIX)) {
    // GitHub 也會送舊的 `sha1=`。我們不接受 SHA-1。
    return {
      ok: false,
      reason: header.includes('=') ? 'unsupported_algorithm' : 'malformed_header',
    };
  }

  const provided = header.slice(PREFIX.length);

  // timingSafeEqual 對長度不同的 Buffer 會拋錯，所以長度必須先檢查。
  // 長度本身不是秘密（SHA-256 摘要長度公開），提早回傳不洩漏任何東西。
  if (provided.length !== HEX_DIGEST_LENGTH) return { ok: false, reason: 'length_mismatch' };
  if (!/^[0-9a-f]{64}$/i.test(provided)) return { ok: false, reason: 'malformed_header' };

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');

  const providedBuf = Buffer.from(provided.toLowerCase(), 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');

  if (providedBuf.length !== expectedBuf.length) return { ok: false, reason: 'length_mismatch' };

  return timingSafeEqual(providedBuf, expectedBuf)
    ? { ok: true }
    : { ok: false, reason: 'mismatch' };
}

/**
 * 產生簽章。**僅供測試與本地開發用**（產生假 webhook）。
 * 正式流程不需要簽任何東西——我們只驗證，不發送。
 */
export function signPayload(rawBody: Buffer, secret: string): string {
  return `${PREFIX}${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}
