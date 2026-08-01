/**
 * 型別安全的 SQLite 查詢封裝（SPEC.md §10）。
 *
 * 設計原則：
 *   - 全部用 prepared statement + 參數化查詢，禁止字串拼接 SQL。
 *   - 布林在 TS 端是 boolean，在 DB 端是 0/1，轉換集中在這一層。
 *   - 需要「讀出剛寫入的整列」時用 `RETURNING` 或立即 `SELECT`，
 *     不依賴呼叫端自己組裝 Row。
 *   - R2：任何方法都不接受、不儲存「原始 log / 原始 webhook body」。
 *     `EventRepository.insertPending` 只收 rawBody 是為了在方法內部算
 *     SHA-256 digest，digest 算完 buffer 就不再被引用。
 */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { ulid } from 'ulid';

import { EVENT_STATUSES } from '../types/events.js';
import type { EventStatus, GitHubEventType } from '../types/events.js';
import type {
  InstallationRow,
  EventRow,
  CaseRow,
  FeedbackRow,
  MemeCardRow,
  LLMUsageRow,
  TitleSource,
  LLMPurpose,
} from '../types/db.js';
import type { FeedbackValue } from '../types/config.js';
import type { ErrorClass, Severity, ConfidenceLevel } from '../types/verdict.js';
import type { SceneId, CompressionLevel } from '../types/scene.js';

function toDbBool(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

function requireRow<T>(row: T | undefined, what: string): T {
  if (row === undefined) {
    throw new Error(`預期存在但讀不到的資料列：${what}`);
  }
  return row;
}

/* ═══════════════════════════════════════════════════════════════════ */
/* EventRepository */
/* ═══════════════════════════════════════════════════════════════════ */

/** `insertPending` 的輸入。刻意保留 `rawBody`（Buffer）只為了算 digest——
 * 它絕不會被寫進任何欄位，方法內部算完 SHA-256 後就不再使用它（R2）。
 *
 * ⚠️ 修正（P1-06 builder review）：`installationId` / `repoFullName` 原本
 * 宣告成必填 `string`，但 `events` 表的這兩欄位本身可為 NULL——理由見本檔
 * 開頭與 `migrations/0001_init.sql` 的說明：webhook handler 依 R3 在驗簽後
 * 立刻落庫，當下還沒 parse payload，不可能知道 installation 或 repo 是誰。
 * `EventRow`（讀側，`types/db.ts`）已經是 `string | null`，這裡（寫側）沒
 * 跟著改是 P1-05 review 那次修正的遺漏，導致 webhook 唯一合法的呼叫方式
 * （P1-06 的 `enqueue`）在型別層根本無法呼叫這個方法。改成與 `EventRow`
 * 一致的 `string | null`；SQL 與底層 DB 欄位本來就允許 NULL，不需要跟著改。 */
export interface NewEventInput {
  readonly deliveryId: string;
  readonly installationId: string | null;
  readonly eventType: GitHubEventType;
  readonly repoFullName: string | null;
  readonly runId: number | null;
  /** 冪等鍵第二分量。見 `types/db.ts` `EventRow.run_attempt` 的說明。 */
  readonly runAttempt: number | null;
  readonly runUpdatedAt: string | null;
  readonly receivedAt: string;
  readonly rawBody: Buffer;
}

export type InsertPendingOutcome = 'accepted' | 'duplicate';

/**
 * P1-09 redteam RT1-02 修補：`ON CONFLICT(delivery_id)` 只命名了一個仲裁目標，
 * 不會攔截 `idx_events_run`（`run_id`, `run_attempt`）上的唯一鍵衝突——那是一個
 * *不同*的唯一索引，SQLite 對它照樣拋出 `SQLITE_CONSTRAINT_UNIQUE`。
 *
 * 這個衝突是預期內、確定性的事件（同一個 run 真的被送達了兩次），不是資料庫
 * 不可用。用訊息內容判斷衝突是否來自 `idx_events_run`（而非其他未來可能新增的
 * 唯一索引），是才吞掉回傳 `'duplicate'`；不是就照原樣往外拋，讓呼叫端
 * （`enqueue.ts`）的既有 catch-all 走 R4 的 `'unavailable'` 路徑，不掩蓋真正未知的錯誤。
 */
function isRunAttemptConflict(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    (err as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE' &&
    err.message.includes('events.run_id') &&
    err.message.includes('events.run_attempt')
  );
}

export class EventRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * 落庫並去重。用 `ON CONFLICT(delivery_id) DO NOTHING` 而非「先 SELECT 再
   * INSERT」，避免兩個並行 request 之間的 race condition（TOCTOU）。
   *
   * ★ R2：只存 `payload_digest = SHA-256(rawBody)` 的 hex，rawBody 本體
   * 絕不出現在任何 SQL 參數裡。
   */
  insertPending(input: NewEventInput): InsertPendingOutcome {
    const digest = createHash('sha256').update(input.rawBody).digest('hex');
    const id = ulid();

    try {
      const result = this.db
        .prepare(
          `INSERT INTO events (
             id, delivery_id, installation_id, event_type, repo_full_name,
             run_id, run_attempt, run_updated_at, received_at, status, attempts,
             next_attempt_at, last_error, payload_digest, completed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, NULL)
           ON CONFLICT(delivery_id) DO NOTHING`,
        )
        .run(
          id,
          input.deliveryId,
          input.installationId,
          input.eventType,
          input.repoFullName,
          input.runId,
          input.runAttempt,
          input.runUpdatedAt,
          input.receivedAt,
          digest,
        );

      return result.changes > 0 ? 'accepted' : 'duplicate';
    } catch (err) {
      // RT1-02：idx_events_run 衝突是預期內的重放/重送，不是 DB 故障。
      if (isRunAttemptConflict(err)) {
        return 'duplicate';
      }
      throw err;
    }
  }

  /**
   * 原子性地取出一筆**可領取**的事件，改成 `processing` 並回傳整列。
   * 用 `UPDATE ... WHERE id = (SELECT ... LIMIT 1) RETURNING *`——單一 SQL
   * 陳述式，SQLite 的寫入序列化保證同時呼叫兩次不會拿到同一筆。
   *
   * 「可領取」= `pending`（從未處理過）或 `failed`（失敗過、等待重試），
   * 且 `next_attempt_at` 已到期或從未設定。
   *
   * `failed` 是**等待重試**，不是終局；終局是 `dead`。把失敗過的事件保留在
   * `failed` 而不是打回 `pending`，是為了讓「這筆事件失敗過」在狀態欄位上
   * 直接看得見——`/stats` 與死信巡檢都要靠它區分「還沒輪到」與「試過而失敗」。
   */
  claimNext(now: string): EventRow | undefined {
    return this.db
      .prepare<[string, string], EventRow>(
        `UPDATE events
           SET status = 'processing', claimed_at = ?
           WHERE id = (
             SELECT id FROM events
             WHERE status IN ('pending', 'failed')
               AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
             ORDER BY received_at ASC
             LIMIT 1
           )
           RETURNING *`,
      )
      .get(now, now);
  }

  markDone(id: string, completedAt: string): void {
    this.db
      .prepare(`UPDATE events SET status = 'done', completed_at = ? WHERE id = ?`)
      .run(completedAt, id);
  }

  markSkipped(id: string, completedAt: string): void {
    this.db
      .prepare(`UPDATE events SET status = 'skipped', completed_at = ? WHERE id = ?`)
      .run(completedAt, id);
  }

  /**
   * 記錄一次失敗並排入下一次重試——狀態回到 `pending`，`next_attempt_at`
   * 由呼叫端算好傳入，`attempts` 遞增，`last_error` 存**遮罩後**的錯誤摘要。
   *
   * ⚠️ 設計決策（見任務回報）：`claimNext` 只挑 `status = 'pending'` 的列
   * （這是任務描述明訂的行為），因此要讓事件真的「留得下來重跑」，
   * `markFailed` 必須把狀態送回 `pending`，而不是停在 `failed`——否則
   * 這筆事件永遠不會再被 `claimNext` 撿到。`failed` 這個列舉值目前保留
   * 給 worker 層未來可能的用法（例如 §4 步驟 ⑫ 提到的「Slack 投遞失敗，
   * case 已存在，只需要重試投遞」情境），不由這個方法設定。
   */
  markFailed(id: string, error: string, nextAttemptAt: string): void {
    this.db
      .prepare(
        `UPDATE events
           SET status = 'pending', attempts = attempts + 1,
               last_error = ?, next_attempt_at = ?
           WHERE id = ?`,
      )
      .run(error, nextAttemptAt, id);
  }

  /** 送進死信區：終態，不再重試。 */
  markDead(id: string, error: string, completedAt: string): void {
    this.db
      .prepare(
        `UPDATE events
           SET status = 'dead', attempts = attempts + 1,
               last_error = ?, completed_at = ?
           WHERE id = ?`,
      )
      .run(error, completedAt, id);
  }

  /**
   * 把卡在 `processing` 的孤兒（程序上次被 SIGKILL 掉、沒能走到
   * markDone/markFailed/markDead 的事件）改回 `pending`。
   *
   * ⚠️ 修正（P1-06 builder review）：這個方法原本用 `received_at` 當孤兒
   * 判準，但 `claimed_at` 欄位其實早就存在（`migrations/0001_init.sql`、
   * `claimNext` 早就在寫入它），且 schema 自己的註解與 `idx_events_claimed`
   * 索引都明講孤兒回收必須用 `claimed_at`——用 `received_at` 會誤判「在
   * 佇列裡等了很久、剛被 claim 沒多久」的事件為孤兒，導致它被提早重複
   * 處理。舊的 JSDoc（下方保留）描述的是這個欄位不存在時的權宜之計，
   * 但欄位一直都在，只是這個方法沒跟著用。改回用 `claimed_at`。
   */
  reclaimOrphans(olderThan: string): number {
    const result = this.db
      .prepare(
        `UPDATE events
           SET status = 'pending'
           WHERE status = 'processing' AND (claimed_at IS NULL OR claimed_at < ?)`,
      )
      .run(olderThan);
    return result.changes;
  }

  countByStatus(): Record<EventStatus, number> {
    const rows = this.db
      .prepare<[], { readonly status: EventStatus; readonly count: number }>(
        `SELECT status, COUNT(*) as count FROM events GROUP BY status`,
      )
      .all();

    const result = Object.fromEntries(EVENT_STATUSES.map((s) => [s, 0])) as Record<
      EventStatus,
      number
    >;
    for (const row of rows) {
      result[row.status] = row.count;
    }
    return result;
  }

  /** 測試與除錯用：依 id 取整列。 */
  findById(id: string): EventRow | undefined {
    return this.db.prepare<[string], EventRow>(`SELECT * FROM events WHERE id = ?`).get(id);
  }
}

/* ═══════════════════════════════════════════════════════════════════ */
/* CaseRepository */
/* ═══════════════════════════════════════════════════════════════════ */

export interface NewCaseInput {
  readonly installationId: string;
  readonly eventId: string;
  readonly repoFullName: string;
  readonly workflowName: string;
  readonly jobName: string;
  readonly runUrl: string;
  readonly headSha: string;
  readonly branch: string;
  readonly signatureHash: string;
  readonly signatureFound: boolean;
  readonly matchedPatternId: string | null;
  readonly errorClass: ErrorClass;
  readonly severity: Severity;
  readonly severityOpinion: Severity | null;
  readonly confidence: ConfidenceLevel;
  readonly redactionRatio: number;
  readonly compressionLevel: CompressionLevel;
  readonly windowStartLine: number | null;
  readonly windowEndLine: number | null;
  readonly verdictJson: string;
  readonly isFallback: boolean;
  readonly fallbackReason: string | null;
  readonly isAnonymous: boolean;
  readonly createdAt: string;
}

export class CaseRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * 在同一個交易內配發 `case_no`（per-installation 單調遞增：讀
   * `installations.next_case_no`、寫入 case、再把 `next_case_no` 加一）並建立
   * `cases` 列。SPEC.md §4：「先落庫、後投遞」——這個方法只負責落庫，
   * 不做任何網路呼叫。
   */
  create(input: NewCaseInput): CaseRow {
    const run = this.db.transaction((): CaseRow => {
      const installation = this.db
        .prepare<[string], { readonly next_case_no: number }>(
          `SELECT next_case_no FROM installations WHERE id = ?`,
        )
        .get(input.installationId);

      if (installation === undefined) {
        throw new Error(`installation 不存在，無法配發 case_no：${input.installationId}`);
      }

      const caseNo = installation.next_case_no;
      const id = ulid();

      this.db
        .prepare(
          `INSERT INTO cases (
             id, installation_id, event_id, case_no, repo_full_name, workflow_name, job_name,
             run_url, head_sha, branch, signature_hash, signature_found, matched_pattern_id,
             error_class, severity, severity_opinion, confidence, redaction_ratio,
             compression_level, window_start_line, window_end_line, verdict_json,
             is_fallback, fallback_reason, is_anonymous, slack_channel_id, slack_ts,
             created_at, resolved_at
           ) VALUES (
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL
           )`,
        )
        .run(
          id,
          input.installationId,
          input.eventId,
          caseNo,
          input.repoFullName,
          input.workflowName,
          input.jobName,
          input.runUrl,
          input.headSha,
          input.branch,
          input.signatureHash,
          toDbBool(input.signatureFound),
          input.matchedPatternId,
          input.errorClass,
          input.severity,
          input.severityOpinion,
          input.confidence,
          input.redactionRatio,
          input.compressionLevel,
          input.windowStartLine,
          input.windowEndLine,
          input.verdictJson,
          toDbBool(input.isFallback),
          input.fallbackReason,
          toDbBool(input.isAnonymous),
          input.createdAt,
        );

      this.db
        .prepare(`UPDATE installations SET next_case_no = ? WHERE id = ?`)
        .run(caseNo + 1, input.installationId);

      return requireRow(
        this.db.prepare<[string], CaseRow>(`SELECT * FROM cases WHERE id = ?`).get(id),
        `cases.id=${id}`,
      );
    });

    return run();
  }

  /** SPEC.md §4 步驟 ⑫：投遞成功後回填 Slack 訊息位置。 */
  attachSlackMessage(caseId: string, channelId: string, ts: string): void {
    this.db
      .prepare(`UPDATE cases SET slack_channel_id = ?, slack_ts = ? WHERE id = ?`)
      .run(channelId, ts, caseId);
  }

  /** 累犯偵測（`repeat_tier`）。計數單位是 error signature，不是人（R5）。 */
  countRecentBySignature(installationId: string, signatureHash: string, sinceIso: string): number {
    const row = requireRow(
      this.db
        .prepare<[string, string, string], { readonly n: number }>(
          `SELECT COUNT(*) as n FROM cases
             WHERE installation_id = ? AND signature_hash = ? AND created_at >= ?`,
        )
        .get(installationId, signatureHash, sinceIso),
      'countRecentBySignature',
    );
    return row.n;
  }

  /**
   * 「最快修復獎」：同 signature 下次成功時回填 `resolved_at`。把該
   * installation 下這個 signature 目前所有「尚未回填」的 case 都標記為
   * 已解決——同一個修復通常一次解決同一個 signature 的所有未結案例。
   */
  markResolved(installationId: string, signatureHash: string, resolvedAtIso: string): void {
    this.db
      .prepare(
        `UPDATE cases
           SET resolved_at = ?
           WHERE installation_id = ? AND signature_hash = ? AND resolved_at IS NULL`,
      )
      .run(resolvedAtIso, installationId, signatureHash);
  }

  findById(id: string): CaseRow | undefined {
    return this.db.prepare<[string], CaseRow>(`SELECT * FROM cases WHERE id = ?`).get(id);
  }
}

/* ═══════════════════════════════════════════════════════════════════ */
/* FeedbackRepository */
/* ═══════════════════════════════════════════════════════════════════ */

export class FeedbackRepository {
  constructor(private readonly db: Database.Database) {}

  /** 一人一票，可改。用 `ON CONFLICT(case_id, slack_user_hash) DO UPDATE`——
   * 這是標準 ANSI upsert 語法（非 SQLite 專屬的 `INSERT OR REPLACE`）。 */
  upsert(caseId: string, userHash: string, value: FeedbackValue, createdAt: string): FeedbackRow {
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO feedback (id, case_id, slack_user_hash, value, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(case_id, slack_user_hash) DO UPDATE SET
             value = excluded.value,
             created_at = excluded.created_at`,
      )
      .run(id, caseId, userHash, value, createdAt);

    return requireRow(
      this.db
        .prepare<[string, string], FeedbackRow>(
          `SELECT * FROM feedback WHERE case_id = ? AND slack_user_hash = ?`,
        )
        .get(caseId, userHash),
      `feedback case_id=${caseId}`,
    );
  }
}

/* ═══════════════════════════════════════════════════════════════════ */
/* InstallationRepository */
/* ═══════════════════════════════════════════════════════════════════ */

export interface UpsertInstallationInput {
  readonly ghInstallationId: number;
  readonly accountLogin: string;
  readonly accountType: 'User' | 'Organization';
  readonly slackTeamId: string | null;
  readonly slackChannelId: string | null;
  readonly installedAt: string;
}

export class InstallationRepository {
  constructor(private readonly db: Database.Database) {}

  /** 依 `gh_installation_id` upsert。重新安裝（webhook 重送或 re-install）
   * 會清掉先前的 `uninstalled_at`。 */
  upsert(input: UpsertInstallationInput): InstallationRow {
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO installations (
           id, gh_installation_id, account_login, account_type, slack_team_id,
           slack_channel_id, installed_at, uninstalled_at, next_case_no
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1)
         ON CONFLICT(gh_installation_id) DO UPDATE SET
           account_login = excluded.account_login,
           account_type = excluded.account_type,
           slack_team_id = excluded.slack_team_id,
           slack_channel_id = excluded.slack_channel_id,
           uninstalled_at = NULL`,
      )
      .run(
        id,
        input.ghInstallationId,
        input.accountLogin,
        input.accountType,
        input.slackTeamId,
        input.slackChannelId,
        input.installedAt,
      );

    return requireRow(
      this.db
        .prepare<[number], InstallationRow>(
          `SELECT * FROM installations WHERE gh_installation_id = ?`,
        )
        .get(input.ghInstallationId),
      `installations.gh_installation_id=${input.ghInstallationId}`,
    );
  }

  markUninstalled(ghInstallationId: number, uninstalledAt: string): void {
    this.db
      .prepare(`UPDATE installations SET uninstalled_at = ? WHERE gh_installation_id = ?`)
      .run(uninstalledAt, ghInstallationId);
  }

  /**
   * `installation.deleted` 的資料刪除（SPEC.md §10「資料刪除」）：刪除該
   * installation 底下 cases / feedback / meme_cards / llm_usage /
   * verdict_cache / events 的所有列。依 FK 相依順序刪除（先刪參照
   * `cases` 的表，再刪 `cases` 本身，最後刪 `events`）。
   *
   * ⚠️ 待裁決（見任務回報）：SPEC.md §10 說刪除後要「保留一列匿名的統計
   * 計數」，但目前的 8 張表裡沒有任何一張適合存放這種聚合列，我也不能
   * 新增表（超出本任務允許建立的檔案清單、且會動到 `src/types`）。這裡
   * 沒有實作「保留匿名統計列」的部分，`installations` 本身的列也保留
   * 不刪（因為 §10 的刪除清單沒有列出 `installations`）。
   */
  deleteAllData(installationId: string): void {
    const run = this.db.transaction((): void => {
      this.db
        .prepare(
          `DELETE FROM feedback WHERE case_id IN (SELECT id FROM cases WHERE installation_id = ?)`,
        )
        .run(installationId);
      this.db
        .prepare(
          `DELETE FROM meme_cards WHERE case_id IN (SELECT id FROM cases WHERE installation_id = ?)`,
        )
        .run(installationId);
      this.db.prepare(`DELETE FROM llm_usage WHERE installation_id = ?`).run(installationId);
      this.db.prepare(`DELETE FROM cases WHERE installation_id = ?`).run(installationId);
      this.db.prepare(`DELETE FROM verdict_cache WHERE installation_id = ?`).run(installationId);
      this.db.prepare(`DELETE FROM events WHERE installation_id = ?`).run(installationId);
    });
    run();
  }

  findById(id: string): InstallationRow | undefined {
    return this.db
      .prepare<[string], InstallationRow>(`SELECT * FROM installations WHERE id = ?`)
      .get(id);
  }

  findByGhInstallationId(ghInstallationId: number): InstallationRow | undefined {
    return this.db
      .prepare<[number], InstallationRow>(
        `SELECT * FROM installations WHERE gh_installation_id = ?`,
      )
      .get(ghInstallationId);
  }
}

/* ═══════════════════════════════════════════════════════════════════ */
/* MemeCardRepository */
/* ═══════════════════════════════════════════════════════════════════ */

/** 不在任務「至少要有」清單內，但 `meme_cards` 是 SPEC.md §10 八張表之一，
 * 補上最小封裝以配合 §4 步驟 ⑩（cases 與 meme_cards 同交易內建立）。 */
export interface NewMemeCardInput {
  readonly caseId: string;
  readonly sceneId: SceneId;
  readonly rulePriority: number;
  readonly title: string;
  readonly titleSource: TitleSource;
  readonly shareId: string | null;
  readonly renderMs: number;
  readonly bytes: number;
  readonly createdAt: string;
}

export class MemeCardRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: NewMemeCardInput): MemeCardRow {
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO meme_cards (
           id, case_id, scene_id, rule_priority, title, title_source, share_id,
           render_ms, bytes, view_count, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        id,
        input.caseId,
        input.sceneId,
        input.rulePriority,
        input.title,
        input.titleSource,
        input.shareId,
        input.renderMs,
        input.bytes,
        input.createdAt,
      );

    return requireRow(
      this.db.prepare<[string], MemeCardRow>(`SELECT * FROM meme_cards WHERE id = ?`).get(id),
      `meme_cards.id=${id}`,
    );
  }

  findByShareId(shareId: string): MemeCardRow | undefined {
    return this.db
      .prepare<[string], MemeCardRow>(`SELECT * FROM meme_cards WHERE share_id = ?`)
      .get(shareId);
  }

  incrementViewCount(shareId: string): void {
    this.db
      .prepare(`UPDATE meme_cards SET view_count = view_count + 1 WHERE share_id = ?`)
      .run(shareId);
  }
}

/* ═══════════════════════════════════════════════════════════════════ */
/* LlmUsageRepository */
/* ═══════════════════════════════════════════════════════════════════ */

export interface NewLlmUsageInput {
  readonly caseId: string | null;
  readonly installationId: string;
  readonly purpose: LLMPurpose;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly usd: number;
  readonly latencyMs: number;
  readonly cacheHit: boolean;
  readonly createdAt: string;
}

export class LlmUsageRepository {
  constructor(private readonly db: Database.Database) {}

  record(input: NewLlmUsageInput): LLMUsageRow {
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO llm_usage (
           id, case_id, installation_id, purpose, model, input_tokens, output_tokens,
           cache_read_tokens, usd, latency_ms, cache_hit, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.caseId,
        input.installationId,
        input.purpose,
        input.model,
        input.inputTokens,
        input.outputTokens,
        input.cacheReadTokens,
        input.usd,
        input.latencyMs,
        toDbBool(input.cacheHit),
        input.createdAt,
      );

    return requireRow(
      this.db.prepare<[string], LLMUsageRow>(`SELECT * FROM llm_usage WHERE id = ?`).get(id),
      `llm_usage.id=${id}`,
    );
  }

  /** `monthIso` 為 `YYYY-MM`（如 `2026-07`）；用 ISO-8601 字串前綴比對，
   * 不依賴 SQLite 專屬的日期函式。 */
  monthlyUsd(installationId: string, monthIso: string): number {
    const row = requireRow(
      this.db
        .prepare<[string, string], { readonly total: number }>(
          `SELECT COALESCE(SUM(usd), 0) as total FROM llm_usage
             WHERE installation_id = ? AND created_at LIKE ?`,
        )
        .get(installationId, `${monthIso}%`),
      'monthlyUsd',
    );
    return row.total;
  }
}
