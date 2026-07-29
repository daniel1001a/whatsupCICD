/**
 * SPEC.md §9：`.prosecutor.yml` 設定檔格式
 *
 * 設定檔是不可信輸入——任何有 repo 寫入權的人都能改它。
 * 所有值皆須 schema 驗證與夾制。詳見 THREAT_MODEL.md §5。
 */

/* ═══════════════════════════════════════════════════════════════════ */
/* Tone Level */
/* ═══════════════════════════════════════════════════════════════════ */

export const TONE_LEVELS = [0, 1, 2, 3] as const;
export type ToneLevel = (typeof TONE_LEVELS)[number];

/* ═══════════════════════════════════════════════════════════════════ */
/* Locale */
/* ═══════════════════════════════════════════════════════════════════ */

export const LOCALES = ['zh-TW', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

/* ═══════════════════════════════════════════════════════════════════ */
/* Feedback Value */
/* ═══════════════════════════════════════════════════════════════════ */

export const FEEDBACK_VALUES = ['up', 'down'] as const;
export type FeedbackValue = (typeof FEEDBACK_VALUES)[number];

/* ═══════════════════════════════════════════════════════════════════ */
/* ProsecutorConfig Type Definition */
/* ═══════════════════════════════════════════════════════════════════ */

export interface ToneConfig {
  readonly level: ToneLevel;
}

export interface PrivacyConfig {
  readonly anonymous: boolean;
  readonly opt_out: readonly string[];
}

export interface WorkflowsGlobConfig {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

export interface WorkflowsConfig {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly branches: WorkflowsGlobConfig;
}

export interface MemeConfig {
  readonly enabled: boolean;
  readonly share_link: boolean;
  readonly show_repo_name: boolean;
  readonly late_night_scene: boolean;
}

export interface SlackConfig {
  readonly channel: string | null;
  readonly thread_repeats: boolean;
}

export interface DigestConfig {
  readonly enabled: boolean;
  readonly day: string; // 'monday' | 'tuesday' | ... 等 weekday 字串
  readonly hour: number; // 0–23
}

export interface BudgetConfig {
  readonly monthly_usd: number;
  readonly max_cases_per_hour: number;
}

export interface ProsecutorConfig {
  readonly version: number;
  readonly enabled: boolean;
  readonly locale: Locale;
  readonly timezone: string; // IANA timezone
  readonly tone: ToneConfig;
  readonly privacy: PrivacyConfig;
  readonly workflows: WorkflowsConfig;
  readonly meme: MemeConfig;
  readonly slack: SlackConfig;
  readonly digest: DigestConfig;
  readonly budget: BudgetConfig;
}

/* ═══════════════════════════════════════════════════════════════════ */
/* Default Configuration */
/* ═══════════════════════════════════════════════════════════════════ */

/**
 * 預設設定值（逐字對應 SPEC.md §9）
 * 使用 `as const satisfies ProsecutorConfig` 來確保型別安全
 */
export const DEFAULT_CONFIG = {
  version: 1,
  enabled: true,
  locale: 'zh-TW',
  timezone: 'Asia/Taipei',
  tone: {
    level: 1,
  },
  privacy: {
    anonymous: false,
    opt_out: [],
  },
  workflows: {
    include: ['*'],
    exclude: [],
    branches: {
      include: ['*'],
      exclude: [],
    },
  },
  meme: {
    enabled: true,
    share_link: true,
    show_repo_name: false,
    late_night_scene: false,
  },
  slack: {
    channel: null,
    thread_repeats: true,
  },
  digest: {
    enabled: true,
    day: 'monday',
    hour: 10,
  },
  budget: {
    monthly_usd: 20,
    max_cases_per_hour: 20,
  },
} as const satisfies ProsecutorConfig;
