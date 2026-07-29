/**
 * HMAC 驗簽測試。
 *
 * 這是信任邊界，測試的重點不是「正確的簽章會過」，而是
 * **所有不正確的東西都不會過**。每個案例對應 `THREAT_MODEL.md` §5 的一種手法。
 */
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { signPayload, verifyGitHubSignature } from './verify-signature.js';

const SECRET = 'test-webhook-secret-do-not-use';
const BODY = Buffer.from(JSON.stringify({ action: 'completed', hello: 'world' }), 'utf8');

describe('verifyGitHubSignature', () => {
  it('接受正確的簽章', () => {
    expect(verifyGitHubSignature(BODY, signPayload(BODY, SECRET), SECRET)).toEqual({ ok: true });
  });

  it('拒絕缺少標頭——不是略過驗簽', () => {
    expect(verifyGitHubSignature(BODY, undefined, SECRET)).toEqual({
      ok: false,
      reason: 'missing_header',
    });
    expect(verifyGitHubSignature(BODY, '', SECRET)).toEqual({
      ok: false,
      reason: 'missing_header',
    });
  });

  it('拒絕空的 secret（設定錯誤時 fail-closed，不可變成關閉驗簽）', () => {
    // 即使簽章「正確」（用空 secret 簽的），也必須拒絕。
    const sig = signPayload(BODY, '');
    expect(verifyGitHubSignature(BODY, sig, '')).toEqual({
      ok: false,
      reason: 'secret_not_configured',
    });
  });

  it('拒絕 SHA-1 簽章（GitHub 的舊格式，我們不接受）', () => {
    const sha1 = createHmac('sha1', SECRET).update(BODY).digest('hex');
    expect(verifyGitHubSignature(BODY, `sha1=${sha1}`, SECRET)).toEqual({
      ok: false,
      reason: 'unsupported_algorithm',
    });
  });

  it('拒絕 body 被竄改後的簽章', () => {
    const sig = signPayload(BODY, SECRET);
    const tampered = Buffer.from(JSON.stringify({ action: 'completed', hello: 'evil' }), 'utf8');
    expect(verifyGitHubSignature(tampered, sig, SECRET)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('拒絕用別的 secret 簽出來的簽章', () => {
    const sig = signPayload(BODY, 'attacker-guessed-secret');
    expect(verifyGitHubSignature(BODY, sig, SECRET)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('對 body 的空白差異敏感（證明驗的是 raw bytes，不是 parse 後的結構）', () => {
    // 這兩個 JSON 語意相同，但位元組不同。用 A 的簽章去驗 B 必須失敗——
    // 如果這個測試過不了，代表某處偷偷做了正規化。
    const a = Buffer.from('{"a":1,"b":2}', 'utf8');
    const b = Buffer.from('{"a": 1, "b": 2}', 'utf8');
    const sigA = signPayload(a, SECRET);
    expect(verifyGitHubSignature(a, sigA, SECRET)).toEqual({ ok: true });
    expect(verifyGitHubSignature(b, sigA, SECRET)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('拒絕長度不對的摘要', () => {
    expect(verifyGitHubSignature(BODY, 'sha256=abc123', SECRET)).toEqual({
      ok: false,
      reason: 'length_mismatch',
    });
  });

  it('拒絕非十六進位字元（避免 Buffer.from 悄悄吞掉無效位元組）', () => {
    // 64 個字元但含非 hex——若不擋，Buffer.from(...,'utf8') 仍會產生 64 bytes，
    // 比較會失敗但原因會被歸類成 mismatch，掩蓋掉「有人在亂試格式」的訊號。
    expect(verifyGitHubSignature(BODY, `sha256=${'z'.repeat(64)}`, SECRET)).toEqual({
      ok: false,
      reason: 'malformed_header',
    });
  });

  it('拒絕沒有演算法前綴的裸摘要', () => {
    const bare = createHmac('sha256', SECRET).update(BODY).digest('hex');
    expect(verifyGitHubSignature(BODY, bare, SECRET)).toEqual({
      ok: false,
      reason: 'malformed_header',
    });
  });

  it('接受大寫的十六進位摘要（規格未保證大小寫）', () => {
    const upper = createHmac('sha256', SECRET).update(BODY).digest('hex').toUpperCase();
    expect(verifyGitHubSignature(BODY, `sha256=${upper}`, SECRET)).toEqual({ ok: true });
  });

  it('處理空 body', () => {
    const empty = Buffer.alloc(0);
    expect(verifyGitHubSignature(empty, signPayload(empty, SECRET), SECRET)).toEqual({ ok: true });
  });

  it('處理含非 ASCII 位元組的 body', () => {
    const utf8 = Buffer.from(JSON.stringify({ msg: '公訴詞：型別失蹤案 🔨' }), 'utf8');
    expect(verifyGitHubSignature(utf8, signPayload(utf8, SECRET), SECRET)).toEqual({ ok: true });
  });
});
