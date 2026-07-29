/**
 * SPEC.md §4：事件流
 * SPEC.md §10：SQLite Schema (events 表)
 *
 * 事件是 webhook 到本應用的最小可持久化單位。
 * events 表同時是：去重表、待辦佇列、死信區（SPEC.md §3.5）
 */

/* ═══════════════════════════════════════════════════════════════════ */
/* Event Status */
/* ═══════════════════════════════════════════════════════════════════ */

/** 事件在佇列中的狀態 */
export const EVENT_STATUSES = [
  'pending', // 待處理
  'processing', // 正在處理
  'done', // 成功完成
  'skipped', // 因設定跳過（例如 enabled=false）
  'failed', // 失敗但尚未進入死信
  'dead', // 死信：超過重試次數或致命錯誤
] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** GitHub webhook 事件類型 */
export const GITHUB_EVENT_TYPES = [
  'workflow_run',
  'installation',
  'installation_repositories',
] as const;
export type GitHubEventType = (typeof GITHUB_EVENT_TYPES)[number];

/* ═══════════════════════════════════════════════════════════════════ */
/* Incoming GitHub Webhook Payload */
/* ═══════════════════════════════════════════════════════════════════ */

/** GitHub workflow_run webhook 事件（簡化版，只含需要的欄位） */
export interface GitHubWorkflowRunEvent {
  readonly action: 'completed' | 'created' | 'requested' | 'in_progress';
  readonly workflow_run: {
    readonly id: number;
    readonly name: string;
    readonly updated_at: string; // ISO-8601
    readonly conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | 'timed_out' | null;
    readonly run_number: number;
    readonly event: string;
    readonly head_branch: string;
    readonly head_sha: string;
    readonly html_url: string;
  };
  readonly repository: {
    readonly full_name: string;
    readonly html_url: string;
  };
  readonly installation: {
    readonly id: number;
  };
}

/** GitHub installation webhook 事件 */
export interface GitHubInstallationEvent {
  readonly action: 'created' | 'deleted' | 'suspend' | 'unsuspend';
  readonly installation: {
    readonly id: number;
    readonly account: {
      readonly login: string;
      readonly type: 'User' | 'Organization';
    };
  };
}

/** GitHub installation_repositories webhook 事件 */
export interface GitHubInstallationRepositoriesEvent {
  readonly action: 'added' | 'removed';
  readonly installation: {
    readonly id: number;
  };
  readonly repositories_added: Array<{
    readonly full_name: string;
  }>;
  readonly repositories_removed: Array<{
    readonly full_name: string;
  }>;
}

/* ═══════════════════════════════════════════════════════════════════ */
/* Events Table Row Type */
/* ═══════════════════════════════════════════════════════════════════ */

/** 來自 events SQLite 表的行（SPEC.md §10） */
export interface EventRow {
  readonly id: string; // ULID
  readonly delivery_id: string; // X-GitHub-Delivery
  readonly installation_id: string; // REFERENCES installations(id)
  readonly event_type: GitHubEventType;
  readonly repo_full_name: string;
  readonly run_id: number | null;
  readonly run_updated_at: string | null; // ISO-8601 UTC
  readonly received_at: string; // ISO-8601 UTC
  readonly status: EventStatus;
  readonly attempts: number;
  readonly next_attempt_at: string | null; // ISO-8601 UTC
  readonly last_error: string | null; // 遮罩後的錯誤摘要
  readonly payload_digest: string; // SHA-256(raw body)
  readonly completed_at: string | null; // ISO-8601 UTC
}

/* ═══════════════════════════════════════════════════════════════════ */
/* Retry Configuration */
/* ═══════════════════════════════════════════════════════════════════ */

/** 重試策略 */
export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly backoffMultiplier: number;
}
