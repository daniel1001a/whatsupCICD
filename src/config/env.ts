/**
 * 環境變數載入與驗證。
 *
 * 鐵則：所有 secret 從環境變數注入，絕不進 repo（CLAUDE.md 工程慣例）。
 * 此模組是 secret 進入程式的唯一入口——任何地方要用 secret 都從這裡取，
 * 不得直接讀 `process.env`，以便日後統一做輪替與稽核。
 */

/** 缺少必要環境變數時拋出。訊息只含變數名稱，絕不含值。 */
export class MissingEnvError extends Error {
  constructor(readonly keys: readonly string[]) {
    super(`缺少必要的環境變數：${keys.join(', ')}`);
    this.name = 'MissingEnvError';
  }
}

export interface AppEnv {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly port: number;
  readonly logLevel: string;
  readonly databasePath: string;
  readonly publicBaseUrl: string;

  readonly githubAppId: string;
  readonly githubAppPrivateKey: string;
  readonly githubWebhookSecret: string;

  readonly slackBotToken: string;
  readonly slackSigningSecret: string;

  readonly anthropicApiKey: string;

  /** 用於 HMAC 化 Slack user id（SPEC.md §10 `feedback.slack_user_hash`）。 */
  readonly userHashSecret: string;
}

/** 開發與測試時，這些 secret 允許缺席——但 production 一律必填。 */
const REQUIRED_IN_PRODUCTION = [
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_WEBHOOK_SECRET',
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'ANTHROPIC_API_KEY',
  'USER_HASH_SECRET',
] as const;

function parseNodeEnv(raw: string | undefined): AppEnv['nodeEnv'] {
  return raw === 'production' || raw === 'test' ? raw : 'development';
}

function parsePort(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '3000', 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`PORT 不是合法的連接埠：${raw ?? '(未設定)'}`);
  }
  return parsed;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const nodeEnv = parseNodeEnv(source['NODE_ENV']);

  if (nodeEnv === 'production') {
    const missing = REQUIRED_IN_PRODUCTION.filter((key) => !source[key]);
    if (missing.length > 0) throw new MissingEnvError(missing);
  }

  return {
    nodeEnv,
    port: parsePort(source['PORT']),
    logLevel: source['LOG_LEVEL'] ?? 'info',
    databasePath: source['DATABASE_PATH'] ?? './data/prosecutor.sqlite',
    publicBaseUrl: source['PUBLIC_BASE_URL'] ?? 'http://localhost:3000',

    githubAppId: source['GITHUB_APP_ID'] ?? '',
    githubAppPrivateKey: source['GITHUB_APP_PRIVATE_KEY'] ?? '',
    githubWebhookSecret: source['GITHUB_WEBHOOK_SECRET'] ?? '',

    slackBotToken: source['SLACK_BOT_TOKEN'] ?? '',
    slackSigningSecret: source['SLACK_SIGNING_SECRET'] ?? '',

    anthropicApiKey: source['ANTHROPIC_API_KEY'] ?? '',

    userHashSecret: source['USER_HASH_SECRET'] ?? '',
  };
}
