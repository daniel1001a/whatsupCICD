# STATE.md — 專案狀態

> 每次 session 開始先讀本檔與 `TASKS.yaml`。每個 Phase 結束更新。

---

## 目前狀態

| 項目 | 值 |
|---|---|
| **Phase** | **2 — 管線** |
| **狀態** | 進行中。PO 於 2026-08-01 批准 Phase 1 並同意進 Phase 2 |
| 分支 | `main`（feature 分支已用 `--allow-unrelated-histories` 併入並推送） |
| 最後更新 | 2026-08-01 |
| 下一步 | Sanitizer 核心（P2-01，Tech Lead 親自實作）+ 三個並行 builder task（P2-04/P2-06/P2-07） |

**P1-10 驗收結果**：
- `inspector`（haiku-4.5, low）：逐條打勾 Gate P1 四項 + P1-01～P1-09 每項 DoD，**零缺漏**。12 個 fixture（≥8 要求）、151/151 測試、webhook 387ms（<3s 要求）、`npm run dev` 可一鍵起。
- `critic`（sonnet-5, high）：**PASS**。獨立重驗 `ef24b02`（不只信報告）：重跑 `git show`、typecheck/lint/test/build、並獨立重現 SQLite 錯誤訊息格式驗證 `isRunAttemptConflict` 的比對邏輯。確認 RT1-01/02/04 修補是真的生效，不是表面掩蓋；確認 R2/R4 在整條 queue/webhook 路徑上都成立（grep 過所有 log 呼叫點，無 payload 內容外洩）；確認 RT1-03 展延到 Phase 4 的判斷成立（Q1 自架優先，爆炸半徑限縮在同一客戶內）。
  4 項 should-fix（非阻塞）已處置：
  1. Phase 2 應有明確 DoD 追蹤「Worker 接上真正 EventHandler」，避免重演 main.ts 曾經沒接 enqueue 卻沒人發現的情況 → 已補進 `P2-10`
  2. RT1-03 殘餘風險應寫進 `RISKS.md` 而非只留在 redteam 報告 → 已補 `R-15`
  3. `isRunAttemptConflict` 字串比對無錨定，未來若有更多複合唯一索引可能誤判 → 判斷現階段 schema 規模下優先度低，暫不處理
  4. `extractWorkflowRunKey` 解析失敗退化路徑無 log/metric，觀測不到防禦層悄悄降級 → 已補進 `P4-06`

**P1-09 redteam 一輪重點**：4 個發現（1 critical / 1 high / 1 med / 1 low）。critical（RT1-01
重放防禦層 2/3 從未真正運作，攻擊者側錄一次合法 webhook 可無限重放）、high（RT1-02 idx_events_run
衝突誤判成 DB 不可用）、low（RT1-04 冪等鍵型別誤用）皆已由 Tech Lead 修補並以 9 條新回歸測試釘住
（`ef24b02`）；medium（RT1-03 無 per-installation rate limit）展延至 `P4-01`（已在其 DoD 範圍內，
非 Gate P1 要求）。同時發現並修補一個相鄰 bug：`main.ts` 從未把 `enqueue` 接上 `buildServer`，
實際跑起來的伺服器不論上述修補與否都會對每個 webhook 回 503。完整報告：
`docs/redteam/P1-09-webhook-replay.md`。

**PO 已於 2026-08-01 拍板 Q1–Q7（全部採 Tech Lead 建議）：**
- **Q1 = A 自架優先**：使用者 `fly deploy` 自己的實例、填自己的 Anthropic key，資料不經過我方。
- **Q2 = A + architect 補強**：`opt_out` 與 `tone.level`（會影響到別人的欄位）只走 Slack 側設定；
  其餘純 repo 偏好留在 `.prosecutor.yml`。**GitHub App 維持 `actions:read` + `metadata:read`，不申請 `Contents:Read`**（D-06 → accepted）。
- **Q3 = A**：保留 `SC03` 但預設關閉、改陪伴調性、標題禁提時間。
- **Q4 = A**：`privacy.anonymous` 預設 `false`；但公開迷因卡／分享頁一律不出現人名；`actor_login` 保存但永不做起訴排行榜。
- **Q5 = 做**：加 `llm.enabled:false` template-only 模式（同時是外洩時的 kill switch），排 Phase 3（P3-13 解除 Q5 阻塞）。
- **Q6 = architect 版**：分享連結按鈕觸發、unlisted、卡片預設不顯示 repo 名；保留期 v1 固定（判決 90 天／事件 30 天）；解除安裝不代刪 Slack 訊息。
- **Q7 = 全部同意**：安全優先且不給調鬆開關；DB 名遮罩但保留 `env=` 環境提示；Slack 顯示「已遮罩 N 處」；PII v1 = 信用卡(Luhn)+台灣身分證+美國 SSN；fallback 只給一句人話原因。

---

## Phase 進度

| Phase | 內容 | 狀態 | Gate |
|---|---|---|---|
| **0** | 規格與威脅模型 | ⏳ **等待批准** | SPEC / THREAT_MODEL / TASKS / 風險清單 |
| 1 | 骨架 | ⬜ 未開始 | `npm run dev` 一鍵起、CI 四關、假 webhook < 3s、fixtures ≥ 8 |
| 2 | 管線 | ⬜ 未開始 | sanitizer 12 類 100% 攔截、擷取器 8 fixture 定位正確 |
| 3 | 生成與投遞 | ⬜ 未開始 | 10 golden case、fallback、真實 Slack、場景確定性、不破版 |
| 4 | 硬化 | ⬜ 未開始 | redteam 二輪無新破口、rate limit、`/stats`、pino 乾淨 |
| 5 | 發射 | ⬜ 未開始 | 三步驟安裝、README 首屏截圖、ARCHITECTURE.md |

---

## Phase 0 產出

| 檔案 | 內容 | 狀態 |
|---|---|---|
| `SPEC.md` | 定位／指標／範圍／事件流／權限論證／擷取演算法／公訴詞 schema／場景決策表／設定檔／DB schema／12 條決策 | ✅ |
| `THREAT_MODEL.md` | **20 類**敏感資訊（S01–S20，超出原訂 12 類）+ 7 類明確不遮罩（N01–N07）、每類偵測策略/遮罩格式/誤判漏判/≥3 測試案例、sanitizer 失效模式、webhook 攻擊面、R2 落實、秘密輪替、可發布的 LLM 揭露章節、red team 契約、17 條殘餘風險。3,024 行 | ✅ |
| `TASKS.yaml` | Phase 0–5 完整 DAG，每 task 有 id/描述/依賴/agent/model/effort/DoD/狀態 | ✅ |
| `RISKS.md` | 14 條風險 + 7 個待拍板問題（每題附建議） | ✅ |
| `CLAUDE.md` | 鐵則、團隊分派、成本紀律、流程 | ✅ |
| `DECISIONS.md` | 12 條 ADR，每條含被否決的替代方案 | ✅ |
| `docs/BRAND.md` | 判決書版面、語氣紅線、毒舌 0–3 具體範例、視覺規範 | ✅ |
| `docs/MEME_SCENES.md` | 10 個場景、觸發規則、原創性聲明與設計發想 | ✅ |
| `docs/ARCHITECTURE.md` | 事件流、為什麼非同步、為什麼 log 不落地（骨架，Phase 5 完稿） | 🟡 骨架 |

## Phase 0 驗收結果

**`inspector`（P0-06）**：回報零缺漏——10/10 檔案齊全、62 個 task 無懸空依賴與 ID 碰撞、
跨文件一致性（場景 ID、規則優先序、error_class、表名欄名、設定鍵、鐵則 R1–R7）全部對齊。

⚠️ **Tech Lead 抽查後推翻其中一項**：inspector 宣稱「§7.3 基準值映射：相同列舉集合」，
實際上 `E_UNKNOWN` **沒有** base 映射——而那正是 `signature_found = false` 時最常落到的類別，
會導致算不出 severity、連帶讓場景選擇失去輸入。已修（`E_UNKNOWN → minor`，封頂 `moderate`）。
另自查出 §8.3 的笛卡兒積數字誤植（100k → 實際 16,896）。
**教訓：低 effort 的驗收報告要抽查，「全部 PASS」本身就是一個該懷疑的訊號。**

**`critic`（P0-07）**：判定 **有條件放行**。4 項必須修、5 項應該修。

| # | critic 的必須修 | 處置 |
|---|---|---|
| 1 | §7.5 只擋 `https?://`，但 Slack 會自動連結**裸網域**（`evil.example.net/patch`），形成規格自稱要擋卻擋不住的釣魚路徑 | ✅ 已修，但**不用它建議的正則方案**。改為渲染層 `plain_text`（結構上不可能自動連結，且不必維護 TLD 清單），正則檢查降為第二道 |
| 2 | §8.4 的 ASCII token 檢查對預設語系 `zh-TW` 是**空判斷**——全中文的編造指控含零個 ASCII token，驗證恆為真。R7 對預設情境等於沒有技術防線 | ✅ 已修。改為四層（T1 輸入隔離 / T2 語彙拒絕清單 / T3 CJK 2-gram 涵蓋率 ≥60% / T4 insufficient 一律模板），並訂下「redteam 若能穩定突破就退回機械組合」的撤退線 |
| 3 | `CLAUDE.md` Gate P3 要求 10 個場景，`RISKS.md` R-14 卻寫「4 個即可通過」——兩份治理文件互斥 | ✅ 矛盾已消除，但**不採用它的修法**（它建議把 Gate 改成 ≥4）。改為把降級路徑明確標記成「需 PO 批准的備案」——Tech Lead 不得自行放寬 PO 訂的驗收標準 |
| 4 | 事件流是「先投遞 Slack、後落庫」，中途失敗會讓回饋按鈕引用不存在的 `case_id`，例外多半被吞掉，**靜默腐蝕北極星指標的分子** | ✅ 已修。順序倒轉為「交易內先建 cases + meme_cards → 投遞 → 回填 slack_ts」，同時解決投遞失敗可重試而不必重跑 LLM |

應該修 5 項，全部採納：快取命中須重新求值健檢與夾制（快取的是文案不是判斷）、
`cases` 加 `matched_pattern_id`、場景測試改為「每規則正例 + 邊界對照組」為主／窮舉為輔、
`THREAT_MODEL.md` §5.6 的 `信心程度` 型別走樣（0–100 整數 → 四值 enum）、
§3 In Scope 補上指向 Q2 的但書。

---

## Phase 0 的關鍵決定

1. **量刑由伺服器確定性計算，LLM 只給意見**（D-03）——原本的 schema 讓 LLM 決定量刑，
   但這與 Gate P3 的「場景選擇同輸入同輸出」直接衝突，也讓量刑可被 prompt injection 操縱。
2. **LLM 永遠不輸出人名**（D-05）——這是 R5 最大的技術風險的唯一有效防線。
3. **累犯綁 error signature，不綁人**（D-10）——R5 的具體落實，且綁 signature 其實更有用。
4. **遮罩率 > 40% 直接不呼叫 LLM**（D-12）——送滿版 `[REDACTED]` 只會得到編造的根因。
5. **不申請 `Contents: Read`**（D-06，proposed）——待 Q2 拍板。
6. **遮罩佔位符帶每事件隨機鹽的關聯後綴**（D-13，architect 提出）——保住「同一個值重複出現」這個高價值訊號，同時讓離線還原在資訊理論上不成立。
7. **明確列出「不遮罩」清單 N01–N07**（D-14，architect 提出）——「我們沒遮罩什麼」是比「我們遮罩了什麼」更強的公開主張。

## Phase 0 發現的內部矛盾（已提交拍板）

| 矛盾 | 位置 | 處置 |
|---|---|---|
| LLM 輸出「量刑」 vs Gate P3「場景選擇同輸入同輸出」 | 【1】schema vs Gate P3 | 已解：量刑改伺服器確定性計算（D-03） |
| **`.prosecutor.yml` 在 repo 內 vs R5 opt-out** | 【4】In Scope vs R5 | **未解，阻塞 Phase 1**：任何 repo 貢獻者都能把別人從 opt-out 名單刪掉、把毒舌強度調到 3。待 Q2 |
| `.prosecutor.yml` 在 private repo 需要 `contents:read` vs R6 | 【4】In Scope vs R6 | **未解，阻塞 Phase 1**。待 Q2（同上，兩個理由指向同一個處置） |
| 「深夜提交」場景 vs R5「不得提及非工作時間行為」 | 【4】場景清單 vs R5 | 預設關閉 + 改為陪伴調性；待 Q3 |
| 「三步驟安裝」vs 自架模式的實際步驟數 | 【9】檢查表 | 待 Q1 |

---

## Agent 呼叫統計

### Phase 0

| 角色 | 模型 | 呼叫次數 | 大致規模 | 產出 |
|---|---|---|---|---|
| tech-lead | sonnet-5 | — | 8 個檔案 | SPEC / TASKS / RISKS / CLAUDE / DECISIONS / BRAND / MEME_SCENES / ARCHITECTURE |
| `architect` | opus-5 (high) | **1**（額度 1/3） | 1 個檔案 · 3,024 行 · ~140k tokens · 11 tool calls · 47 min | `THREAT_MODEL.md` |
| `builder` | sonnet-5 | 0 | — | — |
| `grunt` | haiku-4.5 | 0 | — | — |
| `redteam` | sonnet-5 | 0 | — | Phase 1 起每 Phase ≥1 |
| `critic` | sonnet-5 (high) | **1** | ~111k tokens · 14 tool calls · 8 min | 有條件放行：4 必須修 + 5 應該修 |
| `inspector` | haiku-4.5 (low) | **1** | ~102k tokens · 22 tool calls · 3 min | 零缺漏（抽查後推翻 1 項） |
| `illustrator` | sonnet-5 | 0 | — | Phase 3 |

**architect 額度**：1 / 3 已用。剩餘 2 次保留給重大架構岔路。

### 累計

| 角色 | 累計呼叫 |
|---|---|
| architect | 1 / 3 |
| 其他 | 0 |

---

## 成本紀錄

| Phase | 開發端（agent） | 產品端（LLM 執行） |
|---|---|---|
| 0 | 未計量（無實作） | n/a — 尚無執行環境 |

產品端成本從 Phase 3 起由 `llm_usage` 表自動記錄，`/stats` 端點（P4-04）可查。

---

## 待辦提醒（跨 Phase）

- [ ] `P0-06` inspector 驗收 · `P0-07` critic 挑戰
- [ ] Q1 拍板後回填 `SPEC.md` §5 與 `TASKS.yaml` P5-01 的安裝步驟
- [ ] Q2 拍板後定案 `DECISIONS.md` D-06 狀態（proposed → accepted）
- [ ] Q3 拍板後定案 `SC03` 去留（`docs/MEME_SCENES.md` / `scenes/rules.json` 規則 90）
- [ ] Q5 拍板後決定 `P3-13`（template-only 模式）是否進 Phase 3
- [ ] Q7 拍板後 `P1-07` 才能開工（fixtures 來源）
- [ ] `docs/BRAND.md` §5 的實際色碼待 Phase 3 由 illustrator 提案後回填
- [ ] `docs/ARCHITECTURE.md` §4/§5 待 Phase 2/3 實作後補完
