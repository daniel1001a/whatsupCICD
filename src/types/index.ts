/**
 * 統一的型別匯出點
 *
 * 應用各部分應該從本檔案 import 所需型別，避免深層嵌套的 import 路徑。
 */

// ════════════════════════════════════════════════════════════════
// verdict.ts — 公訴詞相關型別
// ════════════════════════════════════════════════════════════════
export type {
  ConfidenceLevel,
  Severity,
  ErrorClass,
  DefendantRef,
  RootCauseHypothesis,
  RecommendedFix,
  Verdict,
  ProcessedVerdict,
} from './verdict.js';
export {
  CONFIDENCE_LEVELS,
  SEVERITY_LEVELS,
  ERROR_CLASSES,
  NON_HUMAN_ERROR_CLASSES,
  DEFENDANT_REFS,
} from './verdict.js';

// ════════════════════════════════════════════════════════════════
// events.ts — webhook 事件與佇列相關型別
// ════════════════════════════════════════════════════════════════
export type {
  EventStatus,
  GitHubEventType,
  GitHubWorkflowRunEvent,
  GitHubInstallationEvent,
  GitHubInstallationRepositoriesEvent,
  EventRow,
  RetryPolicy,
} from './events.js';
export {
  EVENT_STATUSES,
  GITHUB_EVENT_TYPES,
} from './events.js';

// ════════════════════════════════════════════════════════════════
// config.ts — .prosecutor.yml 設定檔相關型別
// ════════════════════════════════════════════════════════════════
export type {
  ToneLevel,
  Locale,
  FeedbackValue,
  ToneConfig,
  PrivacyConfig,
  WorkflowsGlobConfig,
  WorkflowsConfig,
  MemeConfig,
  SlackConfig,
  DigestConfig,
  BudgetConfig,
  ProsecutorConfig,
} from './config.js';
export {
  TONE_LEVELS,
  LOCALES,
  FEEDBACK_VALUES,
  DEFAULT_CONFIG,
} from './config.js';

// ════════════════════════════════════════════════════════════════
// scene.ts — 迷因場景相關型別
// ════════════════════════════════════════════════════════════════
export type {
  SceneId,
  RepeatTier,
  SceneFeatures,
  SceneRule,
  SceneCondition,
  TextSlot,
  WatermarkSlot,
  SceneDefinition,
  CompressionLevel,
} from './scene.js';
export {
  SCENE_IDS,
  REPEAT_TIERS,
  COMPRESSION_LEVELS,
} from './scene.js';

// ════════════════════════════════════════════════════════════════
// db.ts — 資料庫行型別
// ════════════════════════════════════════════════════════════════
export type {
  InstallationRow,
  EventRow as EventRowDB,
  CaseRow,
  FeedbackRow,
  MemeCardRow,
  LLMUsageRow,
  VerdictCacheRow,
  SchemaMigrationRow,
  TitleSource,
  LLMPurpose,
} from './db.js';
export {
  TITLE_SOURCES,
  LLM_PURPOSES,
} from './db.js';
