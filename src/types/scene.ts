/**
 * SPEC.md §8：迷因卡
 * - §8.3 場景選擇決策表（確定性，first-match-wins）
 * - §8.5 場景庫資料格式
 *
 * 場景選擇的所有輸入都是確定性的（不含 LLM 輸出），
 * 因此場景選擇本身也是確定性的。
 */

import type { ConfidenceLevel, Severity, ErrorClass } from './verdict.js';

/* ═══════════════════════════════════════════════════════════════════ */
/* Scene Identifiers */
/* ═══════════════════════════════════════════════════════════════════ */

export const SCENE_IDS = [
  'SC01_FIRST_SUMMONS',
  'SC02_REPEAT_OFFENDER',
  'SC03_MIDNIGHT_BENCH',
  'SC04_MISSING_EVIDENCE',
  'SC05_DEPENDENCY_HELL',
  'SC06_ONE_LINE_VERDICT',
  'SC07_FRIDAY_DEPLOY',
  'SC08_GAVEL_STORM',
  'SC09_COURT_CLOSED',
  'SC10_INSUFFICIENT',
] as const;
export type SceneId = (typeof SCENE_IDS)[number];

/* ═══════════════════════════════════════════════════════════════════ */
/* Repeat Tier */
/* ═══════════════════════════════════════════════════════════════════ */

/** 同 signature_hash 7 天內的重複次數分級 */
export const REPEAT_TIERS = [0, 1, 2] as const;
export type RepeatTier = (typeof REPEAT_TIERS)[number];

/* ═══════════════════════════════════════════════════════════════════ */
/* Scene Features (場景選擇的輸入特徵) */
/* ═══════════════════════════════════════════════════════════════════ */

/**
 * 場景選擇決策表的輸入特徵（SPEC.md §8.3）
 * 全部為確定性特徵，不含任何 LLM 輸出
 */
export interface SceneFeatures {
  readonly error_class: ErrorClass;
  readonly severity: Severity;
  readonly repeat_tier: RepeatTier;
  readonly is_deploy_workflow: boolean;
  readonly is_friday: boolean;
  readonly is_late_night: boolean;
  readonly fix_is_narrow: boolean;
  readonly test_files_changed: boolean;
  readonly confidence: ConfidenceLevel;
}

/* ═══════════════════════════════════════════════════════════════════ */
/* Scene Rules */
/* ═══════════════════════════════════════════════════════════════════ */

/** 場景選擇規則條件（用於 scenes/rules.json） */
export interface SceneRule {
  readonly priority: number; // 優先序（10, 20, 30, ... 999）
  readonly condition: SceneCondition | null; // null = catch-all
  readonly scene: SceneId;
}

/**
 * 場景選擇條件的單一項
 * 支援各種條件型別，但整個系統只用布林組合
 */
export type SceneCondition =
  | {
      readonly type: 'enum';
      readonly field: keyof SceneFeatures;
      readonly values: readonly unknown[];
    }
  | {
      readonly type: 'boolean';
      readonly field:
        | 'is_deploy_workflow'
        | 'is_friday'
        | 'is_late_night'
        | 'fix_is_narrow'
        | 'test_files_changed';
      readonly value: boolean;
    }
  | { readonly type: 'and'; readonly conditions: readonly SceneCondition[] }
  | { readonly type: 'or'; readonly conditions: readonly SceneCondition[] };

/* ═══════════════════════════════════════════════════════════════════ */
/* Scene Definition */
/* ═══════════════════════════════════════════════════════════════════ */

/** 文字插槽定義 */
export interface TextSlot {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly align: 'left' | 'center' | 'right';
  readonly font: 'mono' | 'sans' | 'serif';
  readonly max_lines: number;
  readonly size_range: readonly [number, number]; // [min, max]
  readonly band: {
    readonly fill: string; // 色碼或色彩角色
    readonly text: string;
  };
}

/** 浮水印插槽定義 */
export interface WatermarkSlot {
  readonly x: number;
  readonly y: number;
  readonly text: string; // 可含 {{REPO_URL}} 等佔位符
}

/** 場景定義（scenes/SC[ID]/scene.json） */
export interface SceneDefinition {
  readonly id: SceneId;
  readonly name_zh: string;
  readonly name_en: string;
  readonly svg: string; // 相對路徑，如 "scene.svg"
  readonly canvas: {
    readonly w: number;
    readonly h: number;
  };
  readonly slots: {
    readonly title: TextSlot;
    readonly watermark?: WatermarkSlot;
  };
  readonly palette_role: string; // 'default' 或其他色彩角色
  readonly origin_note: string; // 設計發想來源
}

/* ═══════════════════════════════════════════════════════════════════ */
/* Compression Level */
/* ═══════════════════════════════════════════════════════════════════ */

/** 錯誤區段壓縮等級（SPEC.md §6.4） */
export const COMPRESSION_LEVELS = ['C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'] as const;
export type CompressionLevel = (typeof COMPRESSION_LEVELS)[number];
