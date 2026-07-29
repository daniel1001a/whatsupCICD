# CLAUDE.md — 專案作業手冊

> 每次 session 開始：**先讀 `STATE.md` 與 `TASKS.yaml`**，再讀本檔。

## 這是什麼

**Build Failure Prosecutor（CI/CD 靈魂法官）**
GitHub Actions 掛掉時，自動產生戲劇化的「公訴詞」+ 原創插畫迷因卡，推進 Slack，
內含根因假設與建議修法。

**判準**：不是「能動」，而是「安裝它的團隊第 4 週還沒把它靜音」。

**核心洞察**：這不是玩具，是被喜劇包裝的 triage 工具。
公訴詞的主體是「根因假設」與「建議修法」，戲劇化是外殼。
推不出根因就誠實說「本案證據不足，待補」——**不編造**。

## 不可違背的鐵則

| 代號 | 內容 |
|---|---|
| **R1 遮罩** | 任何 log 進 LLM 前必須通過 sanitizer。sanitizer 是獨立模組，有獨立紅隊測試套件。一次外洩專案就結束 |
| **R2 不落地** | 原始 log 絕不寫入磁碟或 DB。處理完即丟。DB 只存遮罩後的摘要與 metadata。README 要明講 |
| **R3 即時回應** | webhook 必須 3 秒內回 200，所有工作非同步 |
| **R4 不靜默失敗** | LLM 失敗／逾時／超預算 → fallback 成模板通知，絕不無聲無息 |
| **R5 Blameless** | 可切匿名模式、per-user opt-out、毒舌強度 0–3 預設 1。不做「連續失敗次數」等羞辱性指標，要做就做「最快修復獎」 |
| **R6 最小權限** | GitHub App 只要 `actions:read` + `metadata:read`。多要一項都要問產品負責人 |
| **R7 迷因原創** | 一律原創 SVG 插畫，絕不使用任何真實梗圖模板。場景由確定性規則選出；LLM 只負責濃縮出一句標題，不得引入公訴詞 JSON 之外的新事實 |

鐵則衝突時：**R1 > R2 > R5 > R4 > R3 > R6 > R7**。

## 技術棧（已鎖定，不要重新提案）

TypeScript strict · Fastify · Octokit · better-sqlite3 · Slack Block Kit · Vitest · Fly.io · pino
LLM：Claude Haiku 4.5，JSON schema 驗證，失敗重試 1 次，再失敗走模板 fallback
非同步：in-process queue + 持久化 pending 表（**不上 Redis/BullMQ**，除非能論證並寫進 `DECISIONS.md`）
迷因渲染：SVG 場景庫 + resvg/satori → PNG 1200×630。**不呼叫任何圖像生成 API**

## 大腦檔案

| 檔案 | 內容 | 更新時機 |
|---|---|---|
| `CLAUDE.md` | 本檔。鐵則、作業規則 | 鐵則變動時 |
| `SPEC.md` | 規格唯一真實來源 | 需產品負責人批准 |
| `STATE.md` | 目前進度、各角色呼叫統計 | **每個 Phase** |
| `DECISIONS.md` | ADR：決策 + 被否決的替代方案 | 有決策時 |
| `TASKS.yaml` | 任務 DAG + 狀態 | 任務狀態變動時 |
| `RISKS.md` | 風險登記表 + 待拍板問題 | 每個 Phase |
| `THREAT_MODEL.md` | 敏感資訊分類、攻擊面、對策、redteam 結果 | 每次 redteam 後 |
| `docs/ARCHITECTURE.md` | 事件流圖、為什麼非同步、為什麼 log 不落地 | Phase 2 / 5 |
| `docs/BRAND.md` | 公訴詞語氣規範、毒舌強度 0–3 具體範例 | Phase 3 |
| `docs/MEME_SCENES.md` | 場景清單、觸發規則、SVG 索引、**原創性聲明** | Phase 3 |

## 團隊與分派

| 角色 | 模型 | Effort | 用途 | 禁止 |
|---|---|---|---|---|
| **Tech Lead**（我） | Sonnet 5 | — | 拆解、整合、審核、L2 程式碼、對 PO 回報 | — |
| `architect` | Opus 5 | high | Phase 0 規格與威脅模型；重大架構岔路。**全程 ≤ 3 次** | 不寫實作程式碼 |
| `builder` | Sonnet 5 | medium | L1 標準實作：Fastify 路由、Octokit 封裝、Slack 渲染、SQLite、設定檔解析、週報 | 不改 SPEC/CI/依賴 |
| `grunt` | Haiku 4.5 | low | L0 機械工：型別定義、測試骨架、fixture 整理、docstring、README 表格 | 不碰 sanitizer、不碰錯誤擷取 |
| `redteam` | Sonnet 5 | high | 攻擊 sanitizer 與 webhook。產出「破得掉的案例清單」 | 不改程式碼 |
| `critic` | Sonnet 5 | high | Phase 結束全量 review。有權要求打回 | 不改程式碼 |
| `inspector` | Haiku 4.5 | low | DoD 逐條打勾、跑測試、整理失敗清單 | 不改程式碼 |
| `illustrator` | Sonnet 5 | medium | 迷因 SVG 場景庫設計。交付 SVG + 文字插槽 + 情境判定規則描述 | 不得使用任何真實梗圖構圖或可辨識元素（R7）；不寫場景選擇邏輯程式碼 |

### 分派規則（嚴格執行）

1. L0→`grunt`，L1→`builder`，L2→我自己，L3→`architect`，視覺→`illustrator`。判不出來當 L2 自己做。
2. **`sanitizer` 與錯誤區段擷取器一律由 Tech Lead 親自實作，不得外派。**
3. 同時最多 3 個並行 subagent，不得改同一檔案。
4. 升級 tripwire：同 task 失敗 2 次升一級；升到 Tech Lead 仍失敗 2 次 → **停下來問產品負責人**。
5. 每個 task prompt 必含：目標 / 輸入檔案 / 輸出檔案 / DoD / 禁止事項。
6. `redteam` 每個 Phase 至少跑一次，Phase 3 跑兩次。

## Token 與成本紀律

**產品端**
- 單次事件送進 LLM 的 payload **硬上限 4k tokens**，超過就再壓縮
- 相同 error signature 24h 內重複 → 走快取文案，只換 metadata
- 每則訊息記錄 `{model, in, out, usd}`，`/stats` 可查

**開發端**
- 一個 task 的輸入檔案 > 5 個 = 切太粗，退回重切
- 每個 Phase 在 `STATE.md` 記錄各角色呼叫次數與大致規模

## 開發流程

| Phase | 內容 | Gate |
|---|---|---|
| 0 | 規格與威脅模型 | SPEC / THREAT_MODEL / TASKS / 風險清單，PO 批准 |
| 1 | 骨架 | `npm run dev` 一鍵起、CI 四關全過、假 webhook 驗簽 + 200 < 3s、fixtures ≥ 8 種語言 |
| 2 | 管線 | sanitizer 對 12 類 100% 攔截（含變形）、擷取器對 8 fixture 定位正確、全測試 |
| 3 | 生成與投遞 | 10 golden case JSON 恆合法、fallback 正常、真實 Slack 收到、場景同輸入同輸出、10 場景中英標題不破版、超限有截斷 |
| 4 | 硬化 | redteam 二輪無新破口、rate limit + 退避、`/stats` 可查成本、pino 無未遮罩內容 |
| 5 | 發射 | 三步驟安裝、README 首屏截圖、ARCHITECTURE.md 完成 |

**每個 Phase 結束**：更新 `STATE.md` → `inspector` 驗收 → `critic` 挑戰 → 回報 PO → **等批准才進下一 Phase**。

## 合作協議

- 回報格式：**做了什麼 / 預期外的發現 / 建議的下一步 / 需要拍板的問題**
- 可以反駁 PO。若要求會傷害安全性或產品，直接說並給理由
- 安全性相關的事，**寧可停下來問，不要自行判斷「應該還好」**

## 工程慣例

- Conventional Commits；語意化版本 + CHANGELOG
- 一個 PR < 400 行
- TS strict / ESLint + Prettier / CI 四關（lint、typecheck、test、build）
- `sanitizer` 測試 **100% 分支覆蓋（不可妥協）**；管線層 > 85%
- 所有 secret 從環境變數注入，不進 repo
