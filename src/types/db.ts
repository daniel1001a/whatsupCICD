/**
 * SPEC.md §10：SQLite Schema
 *
 * DB Row 型別：保持 snake_case（對應實際欄位名）
 * 應用層型別用 camelCase
 */

import type { ErrorClass, Severity, ConfidenceLevel } from './verdict.js';
import type { EventStatus, GitHubEventType } from './events.js';
import type { SceneId, CompressionLevel } from './scene.js';
import type { FeedbackValue } from './config.js';

/* ═══════════════════════════════════════════════════════════════════ */
/* installations 表 */
/* ═══════════════════════════════════════════════════════════════════ */

export interface InstallationRow {
  readonly id: string; // ULID, PRIMARY KEY
  readonly gh_installation_id: number; // UNIQUE
  readonly account_login: string;
  readonly account_type: 'User' | 'Organization';
  readonly slack_team_id: string | null;
  readonly slack_channel_id: string | null;
  readonly installed_at: string; // ISO-8601 UTC
  readonly uninstalled_at: string | null; // ISO-8601 UTC
  readonly next_case_no: number; // DEFAULT 1
}

/* ═══════════════════════════════════════════════════════════════════ */
/* events 表 */
/* ═══════════════════════════════════════════════════════════════════ */

export interface EventRow {
  readonly id: string; // ULID, PRIMARY KEY
  readonly delivery_id: string; // UNIQUE
  /**
   * 可為 null。webhook handler 在驗簽後**立刻**落庫並回 200（R3：3 秒預算），
   * 當下還沒 parse payload、也還沒查 installation。worker 解析後回填。
   *
   * `installation.created` 更是本質上先於 installations 列存在——
   * 若設 NOT NULL + FK，處理它時必定違反外鍵。
   */
  readonly installation_id: string | null; // REFERENCES installations(id)
  readonly event_type: GitHubEventType;
  /** 可為 null，同 `installation_id`：落庫時尚未 parse payload。 */
  readonly repo_full_name: string | null;
  readonly run_id: number | null;
  readonly run_updated_at: string | null; // ISO-8601 UTC
  readonly received_at: string; // ISO-8601 UTC
  readonly status: EventStatus;
  readonly attempts: number; // DEFAULT 0
  /**
   * 進入 `processing` 的時刻。孤兒回收必須用這個而不是 `received_at`——
   * 一筆在佇列裡等了一小時、一分鐘前才被 claim 的事件，用 `received_at`
   * 判斷會被誤判成孤兒然後重複處理。
   */
  readonly claimed_at: string | null; // ISO-8601 UTC
  readonly next_attempt_at: string | null; // ISO-8601 UTC
  readonly last_error: string | null; // 遮罩後的錯誤摘要
  readonly payload_digest: string; // SHA-256(raw body)
  readonly completed_at: string | null; // ISO-8601 UTC
}

/** 解除安裝後保留的匿名統計（SPEC.md §10「資料刪除」）。刻意不含任何識別資訊。 */
export interface RetentionStatsRow {
  readonly id: string; // ULID
  readonly deleted_at: string; // ISO-8601 UTC
  readonly cases_count: number;
  readonly feedback_count: number;
  readonly meme_count: number;
  readonly lifetime_usd: number;
  readonly install_days: number;
}

/* ═══════════════════════════════════════════════════════════════════ */
/* cases 表 */
/* ═══════════════════════════════════════════════════════════════════ */

export interface CaseRow {
  readonly id: string; // ULID, PRIMARY KEY
  readonly installation_id: string; // REFERENCES installations(id)
  readonly event_id: string; // REFERENCES events(id)
  readonly case_no: number; // UNIQUE with installation_id
  readonly repo_full_name: string;
  readonly workflow_name: string;
  readonly job_name: string;
  readonly run_url: string;
  readonly head_sha: string;
  readonly branch: string;
  readonly signature_hash: string; // SHA-256，累犯偵測用
  readonly signature_found: 0 | 1; // CHECK (0|1)
  readonly matched_pattern_id: string | null; // 命中的 pattern 規則 ID
  readonly error_class: ErrorClass;
  readonly severity: Severity; // 伺服器計算
  readonly severity_opinion: Severity | null; // LLM 意見
  readonly confidence: ConfidenceLevel; // 夾制後
  readonly redaction_ratio: number; // REAL，0.0 ~ 1.0
  readonly compression_level: CompressionLevel;
  readonly window_start_line: number | null; // 只存行號
  readonly window_end_line: number | null; // 只存行號
  readonly verdict_json: string; // 公訴詞 JSON（已遮罩、已健檢）
  readonly is_fallback: 0 | 1; // CHECK (0|1)
  readonly fallback_reason: string | null;
  readonly is_anonymous: 0 | 1; // CHECK (0|1)
  readonly slack_channel_id: string | null;
  readonly slack_ts: string | null; // Slack 訊息 timestamp
  readonly created_at: string; // ISO-8601 UTC
  readonly resolved_at: string | null; // ISO-8601 UTC，同 signature 下次成功時回填
}

/* ═══════════════════════════════════════════════════════════════════ */
/* feedback 表 */
/* ═══════════════════════════════════════════════════════════════════ */

export interface FeedbackRow {
  readonly id: string; // ULID, PRIMARY KEY
  readonly case_id: string; // REFERENCES cases(id)
  readonly slack_user_hash: string; // HMAC(user_id)，不存明文
  readonly value: FeedbackValue; // CHECK (value IN ('up','down'))
  readonly created_at: string; // ISO-8601 UTC
  // UNIQUE (case_id, slack_user_hash) — 一人一票，可改
}

/* ═══════════════════════════════════════════════════════════════════ */
/* meme_cards 表 */
/* ═══════════════════════════════════════════════════════════════════ */

export const TITLE_SOURCES = ['llm', 'llm_retry', 'truncated', 'template'] as const;
export type TitleSource = (typeof TITLE_SOURCES)[number];

export interface MemeCardRow {
  readonly id: string; // ULID, PRIMARY KEY
  readonly case_id: string; // REFERENCES cases(id)
  readonly scene_id: SceneId;
  readonly rule_priority: number; // 命中哪條規則（優先序）
  readonly title: string;
  readonly title_source: TitleSource;
  readonly share_id: string | null; // UNIQUE, 128-bit base64url
  readonly render_ms: number; // 渲染耗時
  readonly bytes: number; // PNG 位元組數
  readonly view_count: number; // DEFAULT 0
  readonly created_at: string; // ISO-8601 UTC
}

/* ═══════════════════════════════════════════════════════════════════ */
/* llm_usage 表 */
/* ═══════════════════════════════════════════════════════════════════ */

export const LLM_PURPOSES = ['verdict', 'verdict_retry', 'meme_title'] as const;
export type LLMPurpose = (typeof LLM_PURPOSES)[number];

export interface LLMUsageRow {
  readonly id: string; // ULID, PRIMARY KEY
  readonly case_id: string | null; // REFERENCES cases(id)
  readonly installation_id: string; // REFERENCES installations(id)
  readonly purpose: LLMPurpose;
  readonly model: string; // e.g. 'claude-haiku-4-5-20251001'
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number; // DEFAULT 0
  readonly usd: number; // REAL
  readonly latency_ms: number;
  readonly cache_hit: 0 | 1; // CHECK (0|1), DEFAULT 0
  readonly created_at: string; // ISO-8601 UTC
}

/* ═══════════════════════════════════════════════════════════════════ */
/* verdict_cache 表 */
/* ═══════════════════════════════════════════════════════════════════ */

export interface VerdictCacheRow {
  readonly signature_hash: string;
  readonly installation_id: string;
  readonly tone_level: number; // 0–3
  readonly locale: string; // 'zh-TW' | 'en'
  readonly verdict_json: string; // 公訴詞 JSON
  readonly created_at: string; // ISO-8601 UTC
  readonly expires_at: string; // ISO-8601 UTC
  // PRIMARY KEY (signature_hash, installation_id, tone_level, locale)
}

/* ═══════════════════════════════════════════════════════════════════ */
/* schema_migrations 表 */
/* ═══════════════════════════════════════════════════════════════════ */

export interface SchemaMigrationRow {
  readonly version: string; // PRIMARY KEY, e.g. '0001'
  readonly applied_at: string; // ISO-8601 UTC
}
