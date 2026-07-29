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

/**
 * `EventRow` 的正本在 `db.ts`——所有 DB Row 型別都住在那裡。
 * 這裡只做 re-export，避免兩份定義各自漂移。
 *
 * （原本兩個檔案各定義了一份完全相同的 `EventRow`，是 P1-05 review 時發現的。）
 */
export type { EventRow } from './db.js';

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
