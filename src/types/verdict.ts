/**
 * SPEC.md §7：公訴詞 JSON Schema
 * - §7.1 LLM 輸出契約
 * - §7.2 confidence 判定標準與伺服器端夾制
 * - §7.3 severity 量刑計算（伺服器確定性計算）
 */

/* ═══════════════════════════════════════════════════════════════════ */
/* Confidence (信心程度) */
/* ═══════════════════════════════════════════════════════════════════ */

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low', 'insufficient'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

/* ═══════════════════════════════════════════════════════════════════ */
/* Severity (量刑) */
/* ═══════════════════════════════════════════════════════════════════ */

export const SEVERITY_LEVELS = ['minor', 'moderate', 'serious', 'critical'] as const;
export type Severity = (typeof SEVERITY_LEVELS)[number];

/* ═══════════════════════════════════════════════════════════════════ */
/* Error Classification (錯誤分類) */
/* ═══════════════════════════════════════════════════════════════════ */

/** 11 個錯誤類別，由錯誤擷取器的 pattern 決定。見 SPEC.md §6.2 */
export const ERROR_CLASSES = [
  'E_COMPILE',
  'E_TEST',
  'E_DEPENDENCY',
  'E_LINT',
  'E_TIMEOUT',
  'E_OOM',
  'E_NETWORK',
  'E_AUTH',
  'E_INFRA',
  'E_DEPLOY',
  'E_UNKNOWN',
] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

/**
 * 「非戰之罪」四類：基礎設施問題，不是人造成，不應被 modifier 加重。
 * 見 SPEC.md §7.3
 */
export const NON_HUMAN_ERROR_CLASSES: readonly ErrorClass[] = [
  'E_NETWORK',
  'E_TIMEOUT',
  'E_INFRA',
  'E_OOM',
] as const;

/* ═══════════════════════════════════════════════════════════════════ */
/* Defendant Reference */
/* ═══════════════════════════════════════════════════════════════════ */

export const DEFENDANT_REFS = ['commit', 'unknown'] as const;
export type DefendantRef = (typeof DEFENDANT_REFS)[number];

/* ═══════════════════════════════════════════════════════════════════ */
/* LLM 公訴詞 JSON Schema */
/* ═══════════════════════════════════════════════════════════════════ */

/** 根因假設（SPEC.md §7.1） */
export interface RootCauseHypothesis {
  readonly statement: string;
  readonly confidence: ConfidenceLevel;
  readonly reasoning: string;
}

/** 建議修法（SPEC.md §7.1） */
export interface RecommendedFix {
  readonly statement: string;
  readonly file: string | null;
  readonly line: number | null;
}

/** LLM 的公訴詞 JSON 輸出契約（SPEC.md §7.1） */
export interface Verdict {
  readonly defendant_ref: DefendantRef;
  readonly charge: string;
  readonly evidence: readonly string[];
  readonly root_cause_hypothesis: RootCauseHypothesis;
  readonly recommended_fix: RecommendedFix;
  readonly severity_opinion: Severity;
  readonly meme_title: string;
}

/* ═══════════════════════════════════════════════════════════════════ */
/* Processed Verdict (伺服器端夾制後) */
/* ═══════════════════════════════════════════════════════════════════ */

/** 公訴詞處理後的完整資訊（包含伺服器端夾制） */
export interface ProcessedVerdict extends Verdict {
  readonly confidence: ConfidenceLevel; // 夾制後的信心程度
  readonly severity: Severity; // 伺服器計算的量刑
}
