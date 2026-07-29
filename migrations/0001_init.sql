-- migrations/0001_init.sql
--
-- SPEC.md §10「SQLite Schema」的逐字對應。
--
-- 相容性原則（為了無痛換 Postgres，SPEC.md §10）：
--   - 主鍵一律 ULID（TEXT, 26 字元），不用 AUTOINCREMENT
--   - 時間欄位一律 TEXT，ISO-8601 UTC
--   - 布林用 INTEGER + CHECK (x IN (0,1))
--   - 表一律 STRICT
--   - 禁用 INSERT OR REPLACE、WITHOUT ROWID、任何 SQLite 專屬函式
--
-- 裁決紀錄（Tech Lead，P1-05 review）：
--   builder 回報 SPEC.md §10 與 src/types/db.ts 對 events.installation_id 是否可為 null
--   有衝突，並依指示照型別實作成 NOT NULL。**型別是錯的，SPEC 是對的**——
--   installation.created 這個事件本質上先於 installations 列存在，NOT NULL + FK
--   會讓它必定違反外鍵。已改回 nullable 並同步修正型別。
--   同理 repo_full_name 也改為 nullable：webhook handler 在驗簽後立刻落庫，
--   當下還沒 parse payload（R3：3 秒內回 200，parse 是 worker 的事）。

-- 安裝
CREATE TABLE installations (
  id                TEXT PRIMARY KEY,            -- ULID
  gh_installation_id INTEGER NOT NULL UNIQUE,
  account_login     TEXT NOT NULL,
  account_type      TEXT NOT NULL,               -- 'User' | 'Organization'
  slack_team_id     TEXT,
  slack_channel_id  TEXT,
  installed_at      TEXT NOT NULL,
  uninstalled_at    TEXT,
  next_case_no      INTEGER NOT NULL DEFAULT 1
) STRICT;

-- Webhook 事件：同時是去重表、待辦佇列、死信區（R3 的持久化 pending 表）
CREATE TABLE events (
  id             TEXT PRIMARY KEY,               -- ULID
  delivery_id    TEXT NOT NULL UNIQUE,           -- X-GitHub-Delivery，replay 防護
  -- ★ 可為 NULL，這不是疏漏。webhook handler 在驗簽後立刻落庫，此時還沒有解析
  -- payload、也還沒查 installation。`installation.created` 這個事件更是本質上
  -- 先於 installations 列存在——若設 NOT NULL + FK，處理它時必定違反外鍵。
  -- worker 解析 payload 後再回填。
  installation_id TEXT REFERENCES installations(id),
  event_type     TEXT NOT NULL,
  -- 同理可為 NULL：落庫時尚未 parse payload。
  repo_full_name TEXT,
  run_id         INTEGER,
  run_updated_at TEXT,
  received_at    TEXT NOT NULL,
  status         TEXT NOT NULL,                  -- pending|processing|done|skipped|failed|dead
  attempts       INTEGER NOT NULL DEFAULT 0,
  -- 進入 processing 的時刻。孤兒回收必須用這個而不是 received_at——
  -- 一筆在佇列裡等了一小時、一分鐘前才被 claim 的事件，用 received_at 判斷
  -- 會被誤判成孤兒然後重複處理。
  claimed_at     TEXT,
  next_attempt_at TEXT,
  last_error     TEXT,                           -- 遮罩後的錯誤摘要，非原始 log
  payload_digest TEXT NOT NULL,                  -- SHA-256(raw body)，除錯用；★不存 payload 本體
  completed_at   TEXT,
  CHECK (status IN ('pending','processing','done','skipped','failed','dead'))
) STRICT;
-- 佇列掃描同時撿 pending 與 failed（failed 是「等待重試」，不是終局）。
CREATE INDEX idx_events_queue ON events(status, next_attempt_at);
CREATE INDEX idx_events_claimed ON events(status, claimed_at) WHERE status = 'processing';
CREATE UNIQUE INDEX idx_events_run ON events(run_id, run_updated_at) WHERE run_id IS NOT NULL;

-- 判決書（★ 只存遮罩後內容，R2）
CREATE TABLE cases (
  id                TEXT PRIMARY KEY,
  installation_id   TEXT NOT NULL REFERENCES installations(id),
  event_id          TEXT NOT NULL REFERENCES events(id),
  case_no           INTEGER NOT NULL,
  repo_full_name    TEXT NOT NULL,
  workflow_name     TEXT NOT NULL,
  job_name          TEXT NOT NULL,
  run_url           TEXT NOT NULL,
  head_sha          TEXT NOT NULL,
  branch            TEXT NOT NULL,

  signature_hash    TEXT NOT NULL,               -- SHA-256(正規化後的錯誤簽章)，累犯偵測用
  signature_found   INTEGER NOT NULL CHECK (signature_found IN (0,1)),
  matched_pattern_id TEXT,                       -- 命中哪一條 pattern（非 error_class 桶）
                                                 -- 診斷用：error_class 只有 11 個桶，出問題時
                                                 -- 分不出是 TS2339 還是泛用 error: regex 在誤判。
                                                 -- 這是我方定義的規則索引，不含任何 log 內容
  error_class       TEXT NOT NULL,
  severity          TEXT NOT NULL,               -- 伺服器計算，§7.3
  severity_opinion  TEXT,                        -- LLM 意見，僅供校準
  confidence        TEXT NOT NULL,               -- 夾制後，§7.2
  redaction_ratio   REAL NOT NULL,
  compression_level TEXT NOT NULL,               -- 'C0'..'C7'
  window_start_line INTEGER, window_end_line INTEGER,  -- 只存行號，不存內容

  verdict_json      TEXT NOT NULL,               -- 公訴詞 JSON（已遮罩、已健檢）
  is_fallback       INTEGER NOT NULL CHECK (is_fallback IN (0,1)),
  fallback_reason   TEXT,
  is_anonymous      INTEGER NOT NULL CHECK (is_anonymous IN (0,1)),

  slack_channel_id  TEXT, slack_ts TEXT,
  created_at        TEXT NOT NULL,
  resolved_at       TEXT,                        -- 同 signature 下次成功時回填（最快修復獎）
  UNIQUE (installation_id, case_no)
) STRICT;
CREATE INDEX idx_cases_sig ON cases(installation_id, signature_hash, created_at);
CREATE INDEX idx_cases_time ON cases(installation_id, created_at);

-- 回饋
CREATE TABLE feedback (
  id          TEXT PRIMARY KEY,
  case_id     TEXT NOT NULL REFERENCES cases(id),
  slack_user_hash TEXT NOT NULL,                 -- ★ HMAC(user_id)，不存明文 Slack user id
  value       TEXT NOT NULL CHECK (value IN ('up','down')),
  created_at  TEXT NOT NULL,
  UNIQUE (case_id, slack_user_hash)              -- 一人一票，可改
) STRICT;

-- 迷因卡渲染紀錄
CREATE TABLE meme_cards (
  id            TEXT PRIMARY KEY,
  case_id       TEXT NOT NULL REFERENCES cases(id),
  scene_id      TEXT NOT NULL,
  rule_priority INTEGER NOT NULL,                -- 命中哪條規則，除錯與統計用
  title         TEXT NOT NULL,
  title_source  TEXT NOT NULL CHECK (title_source IN ('llm','llm_retry','truncated','template')),
  share_id      TEXT UNIQUE,                     -- 128-bit base64url
  render_ms     INTEGER NOT NULL,
  bytes         INTEGER NOT NULL,
  view_count    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
) STRICT;

-- 成本
CREATE TABLE llm_usage (
  id            TEXT PRIMARY KEY,
  case_id       TEXT REFERENCES cases(id),
  installation_id TEXT NOT NULL REFERENCES installations(id),
  purpose       TEXT NOT NULL,                   -- 'verdict' | 'verdict_retry' | 'meme_title'
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  usd           REAL NOT NULL,
  latency_ms    INTEGER NOT NULL,
  cache_hit     INTEGER NOT NULL DEFAULT 0 CHECK (cache_hit IN (0,1)),
  created_at    TEXT NOT NULL
) STRICT;
CREATE INDEX idx_usage_month ON llm_usage(installation_id, created_at);

-- 24h 文案快取（相同 signature 不重複付費）
CREATE TABLE verdict_cache (
  signature_hash TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  tone_level     INTEGER NOT NULL,
  locale         TEXT NOT NULL,
  verdict_json   TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  PRIMARY KEY (signature_hash, installation_id, tone_level, locale)
) STRICT;

-- 解除安裝後保留的匿名統計（SPEC.md §10「資料刪除」）。
--
-- 刪除 installation 的所有資料時，這裡留下一列**不含任何識別資訊**的計數。
-- 目的是我們仍能回答「總共處理過幾件、幾則走了 fallback」這類產品問題，
-- 而不必為此保留任何屬於已離開客戶的資料。
-- 刻意沒有 installation_id、沒有 repo 名、沒有 account login。
CREATE TABLE retention_stats (
  id              TEXT PRIMARY KEY,             -- ULID
  deleted_at      TEXT NOT NULL,
  cases_count     INTEGER NOT NULL,
  feedback_count  INTEGER NOT NULL,
  meme_count      INTEGER NOT NULL,
  lifetime_usd    REAL NOT NULL,
  install_days    INTEGER NOT NULL              -- 安裝到解除之間的天數
) STRICT;

CREATE TABLE schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT;
