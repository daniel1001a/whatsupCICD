# SPEC.md — Build Failure Prosecutor

> 版本：0.1（Phase 0 草案，待產品負責人批准）
> 最後更新：2026-07-29
> 本文件是實作的唯一真實來源。任何與本文件衝突的程式碼，是程式碼錯了。

---

## 1. 定位與使用者

### 一句話

**GitHub Actions 掛掉時，自動產生一段戲劇化的「公訴詞」與一張原創插畫迷因卡，推進 Slack；公訴詞裡同時給出根因假設與建議修法。**

### 核心洞察（實作時的判準）

這不是玩具，是**被喜劇包裝的 triage 工具**。

- 公訴詞的**主體**是「根因假設」與「建議修法」。
- 戲劇化是**外殼**。
- 迷因卡是外殼的視覺延伸，也是本專案的社群傳播引擎。
- 若某次失敗無法推論根因，**誠實輸出「本案證據不足，待補」**。不編造是鐵則層級的要求，不是建議。

任何一次設計取捨，若「更好笑」與「更有用」衝突，**選更有用**。

### 目標使用者

3–30 人的工程團隊，特別是 CI 通知已經被全體自動忽略的團隊。

決策者是 tech lead / staff engineer；日常受眾是全體工程師。安裝門檻必須低到 tech lead 願意在週五下午花 5 分鐘裝起來。

### 反使用者（明確不服務）

- 需要 on-prem／不得將任何資料送往第三方 LLM 的團隊 → 我們誠實地請他們不要安裝（見 `THREAT_MODEL.md` §8，並考慮 template-only 模式）。
- 300 人以上、已有成熟 SRE incident pipeline 的組織。

---

## 2. 成功指標

### 北極星：第 4 週留存

> 判準不是「能動」，而是「安裝它的團隊第 4 週還沒把它靜音」。

**W4 Engagement Retention（主指標）**

對每個 installation，設安裝日為 D0：

```
W4ER = (D22–D28 期間，收到 ≥1 次回饋按鈕點擊的判決書數)
     ÷ (D22–D28 期間，成功投遞的判決書數)
```

- 目標：**≥ 15%**
- 分母為 0（該週沒有 CI 失敗）→ 該 installation 該週標記 `n/a`，不計入平均。這很重要：CI 變穩定是好事，不該被算成流失。

**為什麼用按鈕點擊而不是 emoji reaction / thread 回覆**：讀取 reaction 需要 `reactions:read`、讀取 thread 需要 `channels:history`。這兩個 scope 讓我們能看到頻道裡的所有訊息，對一個「保證不留資料」的產品來說是不可接受的自我打臉。按鈕點擊透過 Slack interactivity payload 直接送到我們手上，**零額外 scope**。最小權限原則同時適用於 GitHub 與 Slack。

**靜音偵測（反指標，任一觸發即視為流失）**

| 訊號 | 來源 | 可偵測性 |
|---|---|---|
| App 被移除 | GitHub `installation.deleted` webhook | 確定 |
| `.prosecutor.yml` 設 `enabled: false` | 下一次事件讀設定檔時偵測 | 確定 |
| 所有 workflow 被 `workflows.exclude` 排除 | 同上 | 確定 |
| Slack 投遞連續 N 次回 `channel_not_found` / `not_in_channel` | Slack API 錯誤 | 確定 |
| 頻道被 mute | — | **不可偵測**，誠實承認 |
| 連續 4 週 W4ER = 0%（分母 > 5） | 自有資料 | 代理指標 |

### 次要指標

| 指標 | 定義 | 目標 |
|---|---|---|
| 判決書有用率 | 👍 ÷ (👍 + 👎) | ≥ 70% |
| 根因命中率 | 人工抽樣 50 則，根因假設是否指向真正的修改點 | ≥ 55%（含 `insufficient` 誠實回報者算命中） |
| 迷因卡分享點擊 | 分享連結的獨立 UA 造訪數 ÷ 產出卡片數 | ≥ 8% |
| P95 投遞延遲 | webhook 收到 → Slack 訊息送達 | ≤ 45 秒 |
| Webhook ACK | 收到 → 回 200 | P99 ≤ 3 秒（R3） |
| 每則成本 | LLM + 渲染 | ≤ US$0.004 |
| Fallback 率 | 走模板 fallback 的比例 | ≤ 3%（不是 0；R4 的重點是不靜默，不是不 fallback） |

### 不做的指標

不做「誰失敗最多次」「連續失敗天數」等任何以**人**為單位的排行（R5）。累犯的計數單位永遠是 **error signature**，不是人。要做排行就做「最快修復獎」。

---

## 3. 範圍

### In Scope（MVP）

- GitHub App，監聽 `workflow_run.completed` 且 `conclusion == "failure"`
- HMAC-SHA256 驗簽 + replay 防護
- 以 Octokit 抓取失敗 job 的 log
- ANSI 清洗 + GitHub Actions 時間戳／group marker 雜訊移除
- **Sanitizer**：**20 類**敏感資訊（`S01`–`S20`，超出原訂的 12 類最低要求），獨立模組，獨立紅隊測試套件。分類、偵測策略、遮罩格式、誤判風險與測試案例見 `THREAT_MODEL.md` §3；另有明確**不遮罩**的 `N01`–`N07` 清單（§3.21），作為 §8 對外揭露的精確基礎
- **錯誤區段擷取**：定位 error signature，取前 30／後 80 行
- LLM 產出結構化 JSON 公訴詞（schema 驗證 → 重試 1 次 → 模板 fallback）
- Slack Block Kit 判決書 + 「這則有用嗎 👍👎」回饋按鈕
- SQLite：事件紀錄、回饋、每週摘要
- repo 內 `.prosecutor.yml` 設定檔
- 原創迷因卡：10 個手繪 SVG 場景、確定性場景選擇、≤12 字標題、1200×630 PNG、獨立分享連結、角落浮水印
- 安裝流程與落地頁

### Out of Scope（明確不做，寫進 Future Work）

✗ TTS 語音 ✗ GitLab / Jenkins / CircleCI ✗ 自動開 issue／自動修復／自動 rerun
✗ 自訂角色人格包 ✗ 使用者自訂上傳迷因場景 ✗ 付費機制、多租戶計費

### 為未來預留的三個接縫

| 預留項 | 做法 | 在哪個檔案 |
|---|---|---|
| (a) sanitizer 抽成獨立套件 | `src/sanitizer/` 零外部依賴、不 import 專案內任何其他模組、有自己的 `package.json` 草稿與 README | `src/sanitizer/**` |
| (b) CI 供應商 adapter | 定義 `CiAdapter` 介面（`fetchFailedJobLogs`、`parseEvent`、`verifySignature`、`buildRunUrl`），`GitHubAdapter` 是唯一實作。核心管線只認介面 | `src/adapters/ci-adapter.ts` |
| (c) 迷因場景庫資料驅動 | 場景與選擇規則存成 `scenes/*.scene.json` + `scenes/rules.json`，開機時 schema 驗證載入。**選擇邏輯是資料，不是 if-else** | `scenes/**` |

---

## 4. 事件流

```
                        ┌──────────────────────────────────────────┐
                        │  GitHub                                  │
                        │  workflow_run.completed (failure)        │
                        └───────────────────┬──────────────────────┘
                                            │ HTTPS POST
                                            │ X-Hub-Signature-256
                                            ▼
╔═══════════════════════════════════ Fastify ═══════════════════════════════════╗
║  ① POST /webhooks/github                                                      ║
║     ├─ raw body 保留 → HMAC-SHA256 timing-safe 比對      ← 失敗即 401         ║
║     ├─ X-GitHub-Delivery 去重（events 表 UNIQUE）        ← 重複即 200 no-op   ║
║     ├─ 事件過濾（conclusion == failure）                                      ║
║     ├─ INSERT INTO events (status='pending')             ← 持久化，可重跑     ║
║     └─ return 200                                        ── 目標 < 500ms ─────╫──▶ 200
╚═══════════════════════════════════════════════════════════════════════════════╝
                                            │ enqueue (in-process)
                                            ▼
╔════════════════════════════════ Worker（非同步） ═════════════════════════════╗
║                                                                               ║
║  ② 讀 .prosecutor.yml（Octokit, contents 免權限走 repo API）                   ║
║     ├─ 解析失敗／不存在 → 用預設值繼續（絕不因設定檔壞掉而不通知）            ║
║     └─ enabled=false 或 workflow 被排除 → status='skipped'，結束              ║
║                                                                               ║
║  ③ 抓 log（Octokit → 302 → storage）                                          ║
║     ├─ 串流下載，硬上限 (預設) 50 MB，超過即截斷並標記                        ║
║     └─ 只抓 conclusion=failure 的 job，最多 3 個                    ┌────────┐║
║                                                                     │ 原始 log│║
║  ④ 清洗（確定性）                                                   │僅存在於 │║
║     ANSI escape / ISO-8601 時間戳前綴 / ##[group] / ::debug::        │ 記憶體  │║
║                                                                     │ R2      │║
║  ⑤ ★ SANITIZER ★（R1 生死線）                                       └────────┘║
║     12+ 類敏感資訊 → [REDACTED:S##-NAME]                                      ║
║     fail-closed：拋錯或逾時 → 直接跳到 ⑧ 模板 fallback                        ║
║                                                                               ║
║  ⑥ 錯誤區段擷取（確定性）                                                     ║
║     定位 error signature → 前 30 / 後 80 行 → 壓縮階梯 → ≤ 4k tokens          ║
║     產出 error_class、signature_hash、signature_found                         ║
║                                                                               ║
║  ⑦ LLM（Claude Haiku 4.5）                                    ┌──────────────┐║
║     ├─ 24h 內同 signature_hash → 讀快取文案，只換 metadata    │ 出境的只有   │║
║     ├─ 出站前置檢查（獨立高訊號掃描）→ 命中即 abort           │ 遮罩後的     │║
║     ├─ JSON schema 驗證 → 失敗重試 1 次 → 再失敗走 ⑧          │ 錯誤區段     │║
║     └─ 伺服器端夾制：confidence 上限、severity 覆寫           └──────────────┘║
║                                                                               ║
║  ⑧ 若 ⑤⑦ 任一環節失敗 → 模板 fallback（R4，絕不靜默）                        ║
║                                                                               ║
║  ⑨ 迷因卡（確定性選場景 → LLM 標題 → SVG → PNG 1200×630）                     ║
║     場景選擇只吃確定性特徵；標題超限走截斷階梯                                ║
║                                                                               ║
║  ⑩ 投遞 Slack Block Kit 判決書 + 回饋按鈕 + 迷因卡                            ║
║                                                                               ║
║  ⑪ 落庫：cases / meme_cards / llm_usage（皆為遮罩後內容）                     ║
║     events.status = 'done' | 'failed'（失敗留在死信區，可重跑）               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
                    │                                          │
                    ▼                                          ▼
        ┌───────────────────────┐                  ┌───────────────────────┐
        │ Slack                 │                  │ GET /c/:shareId       │
        │ 判決書 + 迷因卡       │                  │ 迷因卡分享頁 (OG meta)│
        │ 👍 / 👎 → POST /slack │                  └───────────────────────┘
        └───────────────────────┘
```

### 為什麼非同步（R3）

GitHub 對 webhook 的容忍時間是 10 秒，超時會標記投遞失敗並重送。我們的管線包含至少三次外部網路往返（抓 log、呼叫 LLM、投遞 Slack），P95 就會吃掉 20–40 秒。同步處理必然逾時 → GitHub 重送 → 我們重複處理 → 使用者收到重複判決書。

因此：**webhook handler 的唯一工作是驗簽、去重、落庫、回 200**。目標 < 500ms，硬預算 3 秒。

### 為什麼原始 log 不落地（R2）

原始 CI log 是本專案接觸到的最敏感資料。它可能包含環境變數傾印、連線字串、內網拓撲。一旦寫入磁碟：

1. 備份、快照、Fly.io volume、error tracker 的 crash dump 都會複製它；
2. 我們就必須回答「你們存了多久、誰能看、怎麼刪」——而正確答案應該是「我們根本沒存」；
3. 一次資料庫外洩就從「我們的服務掛了」升級成「我們外洩了客戶的生產環境憑證」。

所以原始 log 只存在於：HTTP response stream → 記憶體 buffer（有上限）→ 清洗 → 遮罩 → 擷取 → 送 LLM → **buffer 釋放**。全程無檔案、無 DB、無 log 輸出。詳見 `THREAT_MODEL.md` §6。

---

## 5. GitHub App 權限

### 申請清單

| 權限 | 層級 | 必要性論證 | 若沒有會怎樣 |
|---|---|---|---|
| **Actions** | Read-only | 取得 `workflow_run` / `jobs` 清單與 **下載 job log**（`GET /repos/{o}/{r}/actions/jobs/{id}/logs`）。這是產品的全部輸入 | 產品無法存在 |
| **Metadata** | Read-only | GitHub 強制附帶，用於取得 repo 基本資訊、預設分支名、repo URL | 無法安裝 |

### 訂閱事件

| 事件 | 用途 |
|---|---|
| `workflow_run` | 主要觸發（只處理 `action=completed` 且 `conclusion=failure`） |
| `installation` | 安裝／移除，用於資料刪除與留存統計 |
| `installation_repositories` | repo 加入／移除 |

### 明確**不**申請的權限與理由

| 未申請 | 用途會是 | 為什麼不要 |
|---|---|---|
| **Contents: Read** | 讀 `.prosecutor.yml`、讀原始碼佐證根因 | 這會拿到**整個 repo 的原始碼讀取權**。設定檔改用 [`GET /repos/{o}/{r}/contents/.prosecutor.yml`]，此端點在 public repo 免權限；private repo 則需 Contents:Read。**→ 這是必須請產品負責人拍板的取捨，見 Q1** |
| **Checks: Write** | 在 PR 上留 check | 寫入權限，超出「通知」定位 |
| **Issues: Write** | 自動開 issue | Out of scope，且是寫入權 |
| **Pull requests: Read** | 關聯 PR、判斷改了哪些檔案 | 誘人（能大幅提升根因準確度），但是額外的原始碼面讀取權。**Phase 5 之後再評估，不進 MVP** |
| **Members: Read** | 對應 GitHub → Slack 使用者 | 用設定檔手動對應即可 |

> **R6 執行方式**：`app-manifest.yml` 是唯一真實來源，權限清單納入 CI 檢查——若 manifest 出現本表之外的權限，CI 直接失敗。要加權限必須改本文件並經產品負責人批准。

### Slack scope（同樣適用最小權限）

| Scope | 必要性 |
|---|---|
| `chat:write` | 發判決書 |
| `files:write` | 上傳迷因卡 PNG |
| `commands`（選用） | `/prosecutor stats` |

**不申請**：`channels:history`、`reactions:read`、`users:read.email`。理由見 §2。

---

## 6. 錯誤區段擷取演算法

> 這一節與 sanitizer 是本專案的兩個核心。由 Tech Lead 親自實作，不外派。

### 6.0 設計目標

從動輒數萬行的 CI log 中，找出**真正說明失敗原因的那 10 行**，並帶上剛好足夠的上下文，總量壓在 4k tokens 以內。全程確定性——同一份 log 永遠產出同一個區段（可測試、可重現、可回歸）。

### 6.1 前處理（Normalize）

依序執行，每步皆為純函式：

| # | 動作 | 說明 |
|---|---|---|
| N1 | 統一換行 | `\r\n` / `\r` → `\n` |
| N2 | 移除 ANSI | CSI/OSC/SGR 完整序列，含游標移動與清行 |
| N3 | 移除 GHA 時間戳前綴 | 行首 `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s` |
| N4 | 抽出並移除 GHA 標記 | `##[group]` / `##[endgroup]` / `::group::` / `::endgroup::` → 記錄為 **step 邊界**（後續分段用），本身從內文移除 |
| N5 | 抽出 GHA 註解 | `##[error]` / `##[warning]` / `::error file=..,line=..::` → **保留內容並記為 Tier-A 錨點候選**，附帶 file/line 結構化資訊 |
| N6 | 移除純噪音行 | 下載進度條、spinner（`⠋⠙⠹`…）、`\r` 覆寫殘留、npm 進度、`[####    ] 42%` |
| N7 | 保留原始行號 | 每行帶 `{ raw_index, text }`，後續所有操作都保住 `raw_index`，以便回推與測試 |

N4/N5 產出的 step 分段是關鍵：**錯誤幾乎必然在最後一個失敗的 step 內**，先縮小搜索範圍能大幅降低誤判。

### 6.2 錨點定位（Anchor Detection）

pattern registry 存成資料（`src/extractor/patterns.ts`，之後可外移為 JSON），每筆為：

```ts
{ id, tier, lang, regex, error_class, anchor_offset }
```

**Tier 分級（分數越高越優先）**

| Tier | 分數 | 意義 | 範例 |
|---|---|---|---|
| **A** | 100 | 明確的失敗宣告，幾乎不可能誤判 | `##[error]`、`Traceback (most recent call last):`、`error TS2339:`、`error[E0308]:`、`panic:`、`npm ERR! code ELIFECYCLE`、`make: *** [x] Error 1`、`FAILED tests/`、`--- FAIL: Test`、`Exception in thread "main"`、`Segmentation fault`、`Killed`（OOM） |
| **B** | 60 | 強訊號但可能出現在正常輸出 | 行首 `error:` / `ERROR` / `E:`、`AssertionError`、`Expected ... Received ...`、`✗` / `×` / `✖`、`fatal:` |
| **C** | 20 | 弱訊號 | 行內任意位置含 `error` / `failed` / `exception` |
| **D** | −50 | **反錨點**：是結語不是原因，絕不可當錨點 | `Error: Process completed with exit code N`、`##[error]Process completed with exit code N`、`The job has failed`、`Job failed` |

**Tier D 的重要性**：`Error: Process completed with exit code 1` 幾乎總是 log 的最後幾行，且是 Tier-A 形式的字串。天真的實作會 100% 選中它，然後產出「你的 job 失敗了，因為 exit code 1」這種廢話。它必須被明確降權，但**保留為邊界標記**——真正的錯誤在它之前。

**多語言 pattern（起步涵蓋）**：TypeScript/tsc、ESLint、Jest/Vitest、Node/npm/pnpm/yarn、Python/pytest/pip、Go/go test、Rust/cargo、Java/Maven/Gradle、Ruby/RSpec/bundler、PHP/composer、.NET/dotnet、Docker/BuildKit、Terraform、Make/shell、GitHub Actions 自身錯誤。

**選擇規則（確定性，逐條套用）**

1. 搜索範圍優先取 **最後一個 `##[group]` 區塊**；若無分段資訊，取全文。
2. 收集所有 Tier A/B/C 命中，計分：
   `score = tier_score + terminal_bonus − cascade_penalty`
   - `terminal_bonus`：越靠近搜索範圍尾端加分（0–20，線性）。CI log 的尾巴通常是真相。
   - `cascade_penalty`：同一 `pattern.id` 在 20 行內重複命中 → 第 2 筆起每筆 −5（避免被 200 個 TS error 洗版）。
3. 取最高分。**同分時取 `raw_index` 最小者**（編譯器的第一個錯誤是根因，後面是連鎖反應）。
4. 若最高分 < 20（只有 Tier C 或全無命中）→ **降級路徑**（§6.5）。
5. `anchor_offset`：某些 pattern 的真正資訊在下一行（如 `Traceback` 的內容在其後），由 pattern 自帶偏移量修正錨點。

**error_class 分類**（由命中的 pattern 決定，用於迷因場景選擇與週報）

`E_COMPILE` / `E_TEST` / `E_DEPENDENCY` / `E_LINT` / `E_TIMEOUT` / `E_OOM` / `E_NETWORK` / `E_AUTH` / `E_INFRA` / `E_DEPLOY` / `E_UNKNOWN`

`E_INFRA` / `E_TIMEOUT` / `E_NETWORK` / `E_OOM` 這四類代表「大概不是人的錯」，會影響語氣與場景選擇（R5）。

### 6.3 取樣策略

錨點確立後：**前 30 行 / 錨點行 / 後 80 行**（共 111 行）。

不對稱的理由：錯誤的**因**在前（哪個指令、什麼參數），錯誤的**果**在後（stack trace、diff、summary）。stack trace 通常長，所以後方給更多。

邊界處理：
- 不跨越 step 邊界（`##[group]`）取樣，除非該 step 不足 30 行。
- 若後 80 行內出現 Tier D 反錨點（job 結語），在該處截斷——之後都是無用的收尾。
- 保留 `raw_index` 範圍到 `cases` 表，供除錯（只存行號，不存內容）。

### 6.4 壓縮階梯（Token 預算 4k）

Token 估算：`ceil(bytes_utf8 / 3.2)`，保守估法 + 15% headroom。**不呼叫 token counting API**（多一次網路往返、多一次資料出境）。

逐級套用，每級後重新估算，達標即停：

| 級 | 動作 | 預期壓縮 |
|---|---|---|
| C1 | 連續相同行折疊 → `<前一行> … (重複 ×N)` | 高變異 |
| C2 | 移除殘餘進度／下載／`npm WARN deprecated` 類雜訊 | 5–30% |
| C3 | 單行超過 500 字元 → 中間省略 `…[truncated 1234 chars]…` | 對 minified JS / base64 極有效 |
| C4 | 折疊第三方 stack frame：`node_modules/` `site-packages/` `/usr/lib/` `vendor/` `.cargo/registry/` 連續 ≥3 幀 → `… 12 frames elided (node_modules)`。**第一方 frame 一律保留** | 30–60% |
| C5 | 視窗縮減 30/80 → 15/40 | 50% |
| C6 | 視窗縮減 15/40 → 8/20 | 50% |
| C7 | 硬截斷至預算，尾端加 `…[hard truncated]` | 保底 |

達到 C5 以上時，在 `cases` 記錄 `compression_level`，並在 LLM prompt 中告知「上下文已被壓縮」，讓它別過度自信。**C6 以上 → confidence 上限夾制到 `low`。**

### 6.5 失敗時的退路

| 情況 | 行為 |
|---|---|
| 找不到任何 Tier A/B 錨點 | 取 log **最後 120 行**，`signature_found = false`，confidence 上限夾制到 `low` |
| log 為空 / 下載失敗 / 403 | 不呼叫 LLM，直接走 R4 模板 fallback，訊息明說「無法取得 log」 |
| log 超過大小上限 | 只保留**尾端** 50 MB（錯誤在尾巴），標記 `log_truncated = true` |
| 遮罩率 > 40%（遮罩後 placeholder 佔區段字元數比例） | 不呼叫 LLM。理由：送進去的是滿版 `[REDACTED]`，LLM 只會編。走模板 fallback，訊息說明「本次 log 含大量敏感資訊，已略過分析」 |
| 擷取器自身拋錯 | fail-safe：走模板 fallback，記 `error_tracker`，**絕不靜默**（R4） |

---

## 7. 公訴詞 JSON Schema

### 7.1 LLM 輸出契約

LLM **只**輸出以下結構。任何多餘欄位一律被驗證器拒絕（`additionalProperties: false`）。

```jsonc
{
  "defendant_ref": "commit",          // enum: "commit" | "unknown"
                                      // ★ LLM 永遠不輸出人名。被告名稱由伺服器依
                                      //   匿名模式與 opt-out 名單決定（R5）
  "charge": "未經測試即部署",          // 罪名，≤ 20 全形字，對事不對人
  "evidence": [                       // 證據摘要，1–4 條，每條 ≤ 100 全形字
    "CI job `build-web` 於第 3 步崩潰",
    "TypeError: cannot read property 'map' of undefined"
  ],
  "root_cause_hypothesis": {
    "statement": "API 回傳型別變更後未同步更新 client 端型別定義",
    "confidence": "medium",           // enum: high | medium | low | insufficient
    "reasoning": "錯誤發生在解構 API 回應處，且該檔案近期被修改"
  },
  "recommended_fix": {
    "statement": "於 src/api/client.ts 補上 null 檢查並更新型別定義",
    "file": "src/api/client.ts",      // nullable
    "line": 42                        // nullable
  },
  "severity_opinion": "minor",        // enum: minor | moderate | serious | critical
                                      // ★ 僅供校準分析。實際顯示的量刑由伺服器
                                      //   確定性計算，見 §7.3
  "meme_title": "型別失蹤案"           // ≤ 24 display units，見 §8.4
}
```

### 7.2 `confidence` 的判定標準（寫進 prompt，也寫進評測）

信心程度不能是感覺，必須是可稽核的判準：

| 等級 | 判準（全部滿足） | 產品行為 |
|---|---|---|
| `high` | ① 錯誤訊息明確指出錯誤類型 ② 指出具體檔案**與**行號 ③ 修法位置可從證據直接推得 | 正常顯示 |
| `medium` | ① 錯誤類型明確 ② 指出檔案**或**症狀來源 ③ 因果鏈屬合理推論而非直接可見 | 正常顯示，措辭用「假設」 |
| `low` | 只能判斷失敗**類別**（如「依賴解析失敗」），無法指出具體元凶 | 顯示，但建議修法改為「建議調查方向」 |
| `insufficient` | 無法從證據推得任何根因 | `root_cause_hypothesis.statement` **必須**為「本案證據不足，待補」。UI 顯示證據不足區塊，迷因場景強制 `SC10` |

**伺服器端夾制（不信任 LLM 的自評）**

`final_confidence = min(llm_confidence, ceiling)`，其中 ceiling 依序取最嚴格者：

| 條件 | ceiling |
|---|---|
| `signature_found == false` | `low` |
| `compression_level >= C6` | `low` |
| 遮罩率 > 25% | `low` |
| 遮罩率 > 40% | 不呼叫 LLM（§6.5） |
| `recommended_fix.file` 為 null 但 llm 宣稱 `high` | `medium` |

這條規則的意義：**LLM 過度自信是這類產品最容易毀掉信任的失敗模式**。第 3 週有人照著一個高信心但錯誤的建議改了半天，這個 App 就死了。寧可少宣稱。

### 7.3 量刑（severity）由伺服器確定性計算

> **決策**：LLM 的 `severity_opinion` **不直接顯示**。實際量刑由伺服器規則算出。

理由有二：
1. **R5**：量刑的嚴重度會被讀成對人的評價，不能交給一個會被 prompt injection 影響的元件決定。
2. **Gate P3 要求場景選擇同輸入同輸出**。若場景依賴 LLM 輸出，就不可能確定性。

```
severity = max(base_by_error_class, modifiers…)

base:   E_LINT                          → minor
        E_DEPENDENCY                    → minor
        E_UNKNOWN                       → minor      ← 不知道就不加重（見下）
        E_TEST, E_COMPILE               → moderate
        E_AUTH                          → serious
        E_DEPLOY                        → serious
        E_NETWORK, E_TIMEOUT,
        E_INFRA,   E_OOM                → minor      ← 「非戰之罪」四類，見下

modifier（取最高）:
        目標分支 == 預設分支                          → 至少 moderate
        workflow 名稱符合 deploy/release/publish 樣式  → 至少 serious
        同 signature 7 天內第 ≥3 次                    → 升一級（上限 serious）
        同 run 內 ≥3 個 job 失敗                       → 至少 serious

夾制（在 modifier 之後套用，優先於 modifier）:
        error_class ∈ 非戰之罪四類                     → 封頂 minor
        error_class == E_UNKNOWN                      → 封頂 moderate
```

**base 映射必須是全函數**：`error_class` 的每一個 enum 值都必須有 base，否則
`signature_found = false` 的情況（最常落在 `E_UNKNOWN`）會算不出 severity，
連帶讓場景選擇失去輸入。載入時以測試斷言 enum 與 base 表的鍵集合完全相等。

**`E_UNKNOWN` 封頂 `moderate` 的理由**：我們連錯誤類型都判斷不出來，
就沒有立場宣告這是重罪。不確定時往輕的方向走，與 §7.2 的 confidence 夾制同一個原則。

**「非戰之罪」四類**指 `E_NETWORK` / `E_TIMEOUT` / `E_INFRA` / `E_OOM`——
基礎設施問題，不是人造成的，因此連 modifier 都不該加重（R5）。
`E_DEPENDENCY` 雖然 base 同為 `minor`，但**不在**此列：依賴地獄通常確實源自
某次變更，該被 modifier 加重。

`critical` 保留給「預設分支的 deploy workflow 失敗」。

`severity_opinion` 仍然收集並落庫，用於回答「我們的規則跟 LLM 的判斷差多少」——若長期高度一致，未來可考慮簡化規則；若不一致，是規則要調的訊號。

### 7.4 驗證與重試

```
LLM 回應 → JSON.parse → Ajv (strict, additionalProperties:false)
   ├─ 通過 → 伺服器端夾制（§7.2/§7.3）→ 出站健檢（§7.5）→ 渲染
   ├─ 失敗 → 重試 1 次（附上驗證錯誤訊息，temperature 降至 0）
   └─ 再失敗 → 模板 fallback（R4）
```

重試**只有一次**，且重試的 payload 不重新送 log（省 token，也少一次資料出境）。

### 7.5 出站健檢（Prompt Injection 防線）

LLM 輸出在渲染前必須通過：

| 檢查 | 動作 |
|---|---|
| `defendant_ref` 是 enum 值 | 違反即 fallback |
| 所有字串欄位不含 URL（`https?://`），`recommended_fix` 除外且僅允許相對路徑 | 剝除 |
| 所有字串欄位不含 `@` 開頭的 mention 或 Slack `<!channel>` / `<!here>` | 剝除 |
| 不含 `[REDACTED:` 以外形態的疑似秘密（重跑一次輕量 sanitizer 掃描） | 命中即 fallback，記為 **P0 告警** |
| `meme_title` 中的識別符 token（`[A-Za-z_][A-Za-z0-9_.]{2,}`）必須全部出現在輸入的公訴詞 JSON 或錯誤區段中 | 違反即改用確定性模板標題（R7：標題是濃縮，不是加戲） |
| 字串長度上限 | 超出即截斷 |

### 7.6 R4 模板 Fallback

任何環節失敗都走這裡，**絕不靜默**：

```
🔴 Build 失敗：<repo> / <workflow> / <job>
<error 首行（已遮罩，≤200 字）>
<run URL>
（本次未產生公訴詞：<原因>）
```

`<原因>` 必須是人話：`LLM 逾時` / `LLM 回應格式不符` / `log 含大量敏感資訊，已略過分析` / `無法取得 log（權限或 log 已過期）` / `本月成本預算已達上限`。

Fallback 訊息**不含**迷因卡，但**仍含**回饋按鈕（我們想知道 fallback 訊息有沒有用）。

---

## 8. 迷因卡

### 8.1 原創性鐵則（R7）

**一律使用原創插畫。絕不使用任何真實迷因梗圖模板。**

Distracted Boyfriend、Drake、Two Buttons、Woman Yelling at Cat 等全部是受版權保護的攝影作品或漫畫；重現、局部拼接、「重畫成向量版」皆不可。

**為什麼不用哏圖模板**（同時記入 `DECISIONS.md`）：

| 面向 | 哏圖模板 | 原創 SVG 場景 |
|---|---|---|
| 版權 | 幾乎全部有主，商業使用是法律地雷 | 零風險 |
| 品牌 | 看起來跟其他 100 個 bot 一樣 | 有自己的視覺語言，可被認出 |
| 一致性 | 各種畫風／解析度／浮水印雜燴 | 統一色階與線條，能疊成品牌資產 |
| 可控 | 文字位置隨模板變，長標題必爆版 | 文字插槽是設計的一部分，任何長度都不破版 |
| 成本 | 需要圖庫或生成 API | 一次設計，之後零邊際成本 |
| 傳播 | 「又一個哏圖」 | 「這誰畫的？」→ 這才是我們要的反應 |

### 8.2 場景庫（起步 10 個）

視覺母題：**法庭**。扁平向量、有限色階（沿用落地頁深色 + 黃銅）、線條俐落、不用漸層陰影。

| Scene ID | 中文名 | 畫面 | 主要觸發情境 |
|---|---|---|---|
| `SC01_FIRST_SUMMONS` | 初犯傳票 | 空蕩法庭，一張傳票飄落在被告席 | 首次出現的失敗 |
| `SC02_REPEAT_OFFENDER` | 累犯卷宗 | 疊得過高的卷宗塔，最上層貼著案號標籤 | 同 signature 累犯 |
| `SC03_MIDNIGHT_BENCH` | 深夜長凳 | 空法庭、窗外月亮、桌上冷掉的咖啡與一盞小燈 | 深夜提交（**預設關閉**，見 Q3） |
| `SC04_MISSING_EVIDENCE` | 空證物袋 | 標籤寫著「測試」的透明證物袋，空的 | 測試失敗且無測試檔變更 |
| `SC05_DEPENDENCY_HELL` | 纏繞的卷宗 | 用紅線纏成一團的檔案與圖釘（辦案板） | 依賴解析／安裝失敗 |
| `SC06_ONE_LINE_VERDICT` | 一行判決 | 法槌落在一張只有一行字的判決書上 | 建議修法明確且範圍極小 |
| `SC07_FRIDAY_DEPLOY` | 週五庭期 | 牆上日曆圈著週五，門邊放著打包好的公事包 | 週五的 deploy workflow 失敗 |
| `SC08_GAVEL_STORM` | 重槌 | 法槌重擊，桌面裂痕擴散 | 重罪／預設分支部署失敗 |
| `SC09_COURT_CLOSED` | 閉庭 | 拉下的鐵閘、熄燈的法庭、牆上「非戰之罪」告示 | 基礎設施／逾時／網路／OOM（**非人為**） |
| `SC10_INSUFFICIENT` | 證據不足 | 放大鏡照著一張空白的紙 | `confidence == insufficient` |

`SC09` 的存在是 R5 的具體落實：**當失敗不是人造成的，畫面就不該指控任何人。**

### 8.3 場景選擇決策表（確定性，first-match-wins）

輸入特徵**全部為確定性**（不含任何 LLM 輸出）：

```ts
{
  error_class:   E_COMPILE | E_TEST | E_DEPENDENCY | E_LINT | E_TIMEOUT
               | E_OOM | E_NETWORK | E_AUTH | E_INFRA | E_DEPLOY | E_UNKNOWN,
  severity:      minor | moderate | serious | critical,   // §7.3 伺服器計算
  repeat_tier:   0 | 1 | 2,   // 同 signature_hash 7 天內：0 = 首次, 1 = 2 次, 2 = ≥3 次
  is_deploy_workflow: boolean,
  is_friday:     boolean,      // 依 config.timezone 判定
  is_late_night: boolean,      // 依 config.timezone，00:00–05:00
  fix_is_narrow: boolean,      // recommended_fix 同時有 file 與 line
  test_files_changed: boolean, // 由 run 的 head_commit 檔名判斷（不需額外權限）
  confidence:    high | medium | low | insufficient        // §7.2 夾制後
}
```

> `fix_is_narrow` 與 `confidence` 源自 LLM 但**已被伺服器夾制成離散 enum**，且測試會針對「給定這組離散特徵 → 場景固定」驗證。P3 的可重現性判準以離散特徵為輸入定義。

規則存於 `scenes/rules.json`，開機時 schema 驗證。**程式碼只負責依序求值，不含任何場景名稱字面量。**

| 優先序 | 條件 | Scene |
|---|---|---|
| 10 | `confidence == "insufficient"` | `SC10_INSUFFICIENT` |
| 20 | `error_class ∈ {E_INFRA, E_TIMEOUT, E_NETWORK, E_OOM}` | `SC09_COURT_CLOSED` |
| 30 | `severity == "critical"` | `SC08_GAVEL_STORM` |
| 40 | `is_deploy_workflow && is_friday` | `SC07_FRIDAY_DEPLOY` |
| 50 | `is_deploy_workflow && severity == "serious"` | `SC08_GAVEL_STORM` |
| 60 | `error_class == "E_DEPENDENCY"` | `SC05_DEPENDENCY_HELL` |
| 70 | `repeat_tier == 2` | `SC02_REPEAT_OFFENDER` |
| 80 | `error_class == "E_TEST" && !test_files_changed` | `SC04_MISSING_EVIDENCE` |
| 90 | `is_late_night && config.meme.late_night_scene` | `SC03_MIDNIGHT_BENCH` |
| 100 | `fix_is_narrow && severity == "minor"` | `SC06_ONE_LINE_VERDICT` |
| 110 | `repeat_tier == 1` | `SC02_REPEAT_OFFENDER` |
| 999 | *(catch-all，永遠命中)* | `SC01_FIRST_SUMMONS` |

**完整性保證**：規則載入時驗證最後一條必為無條件 catch-all；測試以特徵空間的笛卡兒積窮舉，驗證每組都得到**恰好一個**場景。

特徵空間大小：
`error_class`(11) × `severity`(4) × `repeat_tier`(3) × 5 個布林 × `confidence`(4)
= 11 × 4 × 3 × 2⁵ × 4 = **16,896** 組（若把 `config.meme.late_night_scene` 也納入則 33,792）。
這個規模在單元測試中窮舉只需毫秒級，沒有取樣的必要。

其中有相當比例是**現實中不可達**的組合（例如 `confidence = insufficient`
卻同時 `fix_is_narrow = true`）。測試**仍然涵蓋**它們——完整性的意義正是
「即使輸入荒謬也不會掉進未定義行為」，而不是「合理的輸入都有處理」。

### 8.4 迷因標題

| 項目 | 規範 |
|---|---|
| 長度 | **≤ 24 display units**。CJK／全形 = 2 units，ASCII = 1 unit。等同 12 個中文字或 24 個英文字元 |
| 內容 | 只能濃縮公訴詞 JSON 中已有的事實。**禁止引入新事實或新指控**（R7） |
| 禁止 | 人名、@ mention、URL、emoji、標點結尾 |
| 語言 | 跟隨 `config.locale`（`zh-TW` / `en`） |

**截斷階梯**

1. 超限 → 重新請求 LLM 一次，prompt 明說「上限 N units，目前 M」（此重試與 §7.4 的重試共用同一次額度，不額外呼叫）
2. 仍超限 → 在預算內從最後一個標點／空白／CJK 邊界切斷
3. 仍不行 → 硬切至 budget − 1 並補 `…`，切點必須落在 grapheme cluster 邊界（用 `Intl.Segmenter`）
4. 空字串或全被剝除 → 用確定性模板：`{error_class 中文名}案`（如「型別錯誤案」）

**版面保證**：標題置於畫面上／下方的實心色塊內，色塊高度隨行數（最多 2 行）變動，**永不壓在插畫細節上**。設計時以最長合法標題（24 units）與最短（2 units）各做一次視覺驗收。

### 8.5 場景庫資料格式（預留 (c)）

```
scenes/
  rules.json              # §8.3 的決策表，帶 JSON Schema
  rules.schema.json
  scene.schema.json
  SC01_FIRST_SUMMONS/
    scene.json            # metadata + 文字插槽定義
    scene.svg             # 原創插畫，含 {{TITLE}} 佔位
```

`scene.json`：

```jsonc
{
  "id": "SC01_FIRST_SUMMONS",
  "name_zh": "初犯傳票",
  "name_en": "First Summons",
  "svg": "scene.svg",
  "canvas": { "w": 1200, "h": 630 },
  "slots": {
    "title": {
      "x": 60, "y": 500, "w": 1080, "h": 90,
      "align": "center",
      "font": "mono",
      "max_lines": 2,
      "size_range": [40, 64],       // 依長度自動縮放
      "band": { "fill": "brass", "text": "ink" }
    },
    "watermark": { "x": 60, "y": 600, "text": "{{REPO_URL}}" }
  },
  "palette_role": "default",
  "origin_note": "設計發想來源記於 docs/MEME_SCENES.md"
}
```

渲染：`satori`（JSX → SVG）或直接 SVG 模板替換 → `resvg-js` → PNG 1200×630。**不呼叫任何圖像生成 API。** 字型須內嵌（CJK 子集化，否則 PNG 中文變豆腐——這是 Phase 3 的已知風險，見 `RISKS.md` R-06）。

### 8.6 分享連結

- `GET /c/:shareId`，`shareId` = 128-bit 隨機值 base64url（22 字元），不可枚舉、與案號無關聯
- 頁面含完整 OG / Twitter Card meta，`og:image` 指向 PNG
- 卡片角落浮水印：專案名 + repo 連結（免費且持續的曝光）
- **卡片上不出現**：repo 名稱（除非設定允許）、人名、任何 log 內容、案號以外的識別資訊
- 預設 `unlisted`（有連結即可看）。是否應該預設完全私有 → 見 Q4

---

## 9. `.prosecutor.yml`

放在 repo 根目錄。**完全不設定也必須能跑**——所有欄位皆有預設值。

```yaml
# .prosecutor.yml —— 全部欄位皆為選填，以下即為預設值
version: 1

enabled: true                    # 總開關

locale: zh-TW                    # zh-TW | en
timezone: Asia/Taipei            # IANA tz，用於 is_friday / is_late_night 判定

tone:
  level: 1                       # 0–3 毒舌強度。0=完全正經，1=預設，3=最毒（仍禁人身攻擊）

privacy:
  anonymous: false               # true → 被告一律顯示為「本案被告」，不顯示任何識別資訊
  opt_out: []                    # GitHub username 清單；名單內的人觸發的失敗一律匿名
                                 # 空清單 = 無人 opt-out（opt-out 是個人權利，預設不代人決定）

workflows:
  include: ["*"]                 # glob，對 workflow 名稱比對
  exclude: []                    # 優先於 include
  branches:
    include: ["*"]
    exclude: []

meme:
  enabled: true                  # 迷因卡總開關
  share_link: true               # 是否產生公開分享連結
  show_repo_name: false          # 卡片上是否顯示 repo 名稱
  late_night_scene: false        # 深夜場景（預設關閉，見 R5 與 Q3）

slack:
  channel: null                  # null → 用安裝時設定的預設頻道
  thread_repeats: true           # 同 signature 24h 內重複 → 接在原訊息的 thread

digest:
  enabled: true
  day: monday                    # 週報投遞日
  hour: 10                       # 本地時間

budget:
  monthly_usd: 20                # 超過即全面走模板 fallback 並在頻道公告一次
  max_cases_per_hour: 20         # 單 installation 節流；超過即合併為摘要訊息
```

### 設定檔安全與韌性

| 情況 | 行為 |
|---|---|
| 檔案不存在 | 全部用預設值 |
| YAML 語法錯誤 | 用預設值 + 在該 repo 第一則訊息附一行警告（每 24h 最多一次） |
| 未知欄位 | 忽略並警告，**不報錯** |
| 值超出範圍（如 `tone.level: 9`） | 夾制到合法範圍，警告 |
| 檔案 > 64 KB | 拒絕，用預設值 |
| YAML anchor 炸彈 / 別名爆炸 | 用安全 schema 載入，限制節點數 |

**設定檔是不可信輸入**——任何有 repo 寫入權的人都能改它。所有值皆須 schema 驗證與夾制。詳見 `THREAT_MODEL.md` §5。

---

## 10. SQLite Schema

### 相容性原則（為了無痛換 Postgres）

| 原則 | 做法 |
|---|---|
| 主鍵 | **ULID（TEXT, 26 字元）**，不用 `AUTOINCREMENT`。時間有序，跨 DB 一致，分散式友善 |
| 案號 | `case_no` 是**每 installation 獨立**的單調遞增整數，由交易內 `MAX(case_no)+1` 產生（Postgres 換成 sequence 或 advisory lock）。案號是使用者可見的品牌元素（「案號 #1042」），必須好看 |
| 時間 | `TEXT`，ISO-8601 UTC（`2026-07-29T04:33:00.000Z`）。不用 SQLite 的 `julianday`／整數 epoch |
| 布林 | `INTEGER` 0/1，欄位加 `CHECK (x IN (0,1))` |
| JSON | `TEXT`，應用層負責 parse。不用 SQLite JSON1 專屬函式於查詢中 |
| 表 | 一律 `STRICT`（SQLite 3.37+），型別行為向 Postgres 靠攏 |
| 禁用 | `INSERT OR REPLACE`、`rowid` 依賴、`WITHOUT ROWID`、隱式型別轉換 |
| Migration | `migrations/0001_*.sql` 純 SQL，順序執行，記錄於 `schema_migrations`。只前進不回退（回退用備份） |

### 表定義

```sql
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
  installation_id TEXT REFERENCES installations(id),
  event_type     TEXT NOT NULL,
  repo_full_name TEXT NOT NULL,
  run_id         INTEGER,
  run_updated_at TEXT,
  received_at    TEXT NOT NULL,
  status         TEXT NOT NULL,                  -- pending|processing|done|skipped|failed|dead
  attempts       INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error     TEXT,                           -- 遮罩後的錯誤摘要，非原始 log
  payload_digest TEXT NOT NULL,                  -- SHA-256(raw body)，除錯用；★不存 payload 本體
  completed_at   TEXT,
  CHECK (status IN ('pending','processing','done','skipped','failed','dead'))
) STRICT;
CREATE INDEX idx_events_queue ON events(status, next_attempt_at);
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

CREATE TABLE schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT;
```

### 資料刪除

`installation.deleted` webhook → 刪除該 installation 的**所有**列（cases / feedback / meme_cards / llm_usage / verdict_cache / events），保留一列匿名的統計計數。README 記載手動刪除管道。

---

## 11. 關鍵技術決策

摘要如下，完整論證見 `DECISIONS.md`。

| # | 決策 | 被否決的替代方案 | 理由 |
|---|---|---|---|
| D-01 | in-process queue + `events` 持久化表 | Redis + BullMQ | MVP 是單機。BullMQ 帶來 Redis 這個必須維運、必須備份、必須加進安裝步驟的元件，換來的可靠性我們用「事件先落庫再處理 + 開機時掃 pending」就有 95%。**條件**：當單機吞吐不足或需要多實例時再換，介面先隔離好 |
| D-02 | 迷因卡用原創 SVG 場景庫 | ① 哏圖模板配字 ② 圖像生成 API | 見 §8.1 表。核心是版權歸零 + 品牌可累積 + 版面可控 + 邊際成本為零 |
| D-03 | 量刑由伺服器確定性計算，LLM 只給意見 | LLM 直接決定量刑 | R5（量刑會被讀成對人的評價）+ Gate P3（場景選擇必須確定性）+ prompt injection 防護 |
| D-04 | 場景選擇規則存成 `scenes/rules.json` | 寫死 if-else | 預留 (c)；且讓「規則涵蓋完整」變成可驗證的 schema 檢查而非 code review |
| D-05 | LLM 不輸出人名，被告名由伺服器填 | LLM 輸出 `defendant` 字串 | Prompt injection 可讓 LLM 指控任意人名。這是 R5 的最大技術風險 |
| D-06 | 不申請 `Contents: Read`（待拍板，Q1） | 申請以讀設定檔與原始碼 | R6。取捨見 §5 |
| D-07 | ULID 主鍵 + TEXT 時間 | INTEGER autoincrement + epoch | Postgres 遷移零改寫 |
| D-08 | Token 用字元估算，不呼叫 count API | Anthropic token counting API | 少一次網路往返、少一次資料出境；保守估算 + headroom 足夠 |
| D-09 | 回饋按鈕作為留存主指標 | Slack reaction / thread 分析 | 避免申請 `channels:history`（見 §2） |
| D-10 | 累犯計數綁在 error signature，不綁人 | 綁 committer | R5。這是「文化神器 vs 霸凌工具」的分水嶺 |
| D-11 | Sanitizer fail-closed | 遮罩失敗就送原文 | R1。寧可不通知，不可外洩 |
| D-12 | 遮罩率 > 40% 直接不呼叫 LLM | 照送 | 送滿版 `[REDACTED]` 只會得到編造的根因，違背核心洞察 |

---

## 12. 待拍板問題

見 `RISKS.md` 末節與 Phase 0 回報。

---

## 13. Future Work（明確記錄，非承諾）

TTS 語音判詞 / GitLab 與 Jenkins adapter / 自動開 issue / 自訂角色人格包 / 使用者自訂場景上傳 / 付費與多租戶 / sanitizer 獨立開源套件 / PR 關聯（需 `pull_requests:read`）/ template-only 模式（完全不呼叫 LLM）
