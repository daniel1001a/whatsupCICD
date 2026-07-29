# STATE.md — 專案狀態

> 每次 session 開始先讀本檔與 `TASKS.yaml`。每個 Phase 結束更新。

---

## 目前狀態

| 項目 | 值 |
|---|---|
| **Phase** | **0 — 規格與威脅模型** |
| **狀態** | 產出完成，**等待產品負責人批准** |
| 分支 | `claude/whatsupcicd-project-init-ig43iw` |
| 最後更新 | 2026-07-29 |
| 下一步 | PO 回答 `RISKS.md` 的 7 個問題 → 說 approved → 進 Phase 1 |

**阻塞項**：`RISKS.md` Q1（hosted vs 自架）會改變 Phase 1 的部署設計與 Phase 5 的安裝流程，
Q2（Contents:Read）會改變 GitHub App manifest。這兩題在 Phase 1 開工前必須有答案。
Q3–Q7 可以在 Phase 1 期間回答，不阻塞。

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
| `THREAT_MODEL.md` | 敏感資訊分類、偵測策略、誤判風險、測試案例、webhook 攻擊面、LLM 可見性說明、殘餘風險 | ✅ |
| `TASKS.yaml` | Phase 0–5 完整 DAG，每 task 有 id/描述/依賴/agent/model/effort/DoD/狀態 | ✅ |
| `RISKS.md` | 14 條風險 + 7 個待拍板問題（每題附建議） | ✅ |
| `CLAUDE.md` | 鐵則、團隊分派、成本紀律、流程 | ✅ |
| `DECISIONS.md` | 12 條 ADR，每條含被否決的替代方案 | ✅ |
| `docs/BRAND.md` | 判決書版面、語氣紅線、毒舌 0–3 具體範例、視覺規範 | ✅ |
| `docs/MEME_SCENES.md` | 10 個場景、觸發規則、原創性聲明與設計發想 | ✅ |
| `docs/ARCHITECTURE.md` | 事件流、為什麼非同步、為什麼 log 不落地（骨架，Phase 5 完稿） | 🟡 骨架 |

**尚未驗收**：`P0-06`（inspector 逐條打勾）與 `P0-07`（critic 挑戰）刻意保留到 PO 批准前後執行，
以免對還可能被推翻的規格做全量 review。

---

## Phase 0 的關鍵決定

1. **量刑由伺服器確定性計算，LLM 只給意見**（D-03）——原本的 schema 讓 LLM 決定量刑，
   但這與 Gate P3 的「場景選擇同輸入同輸出」直接衝突，也讓量刑可被 prompt injection 操縱。
2. **LLM 永遠不輸出人名**（D-05）——這是 R5 最大的技術風險的唯一有效防線。
3. **累犯綁 error signature，不綁人**（D-10）——R5 的具體落實，且綁 signature 其實更有用。
4. **遮罩率 > 40% 直接不呼叫 LLM**（D-12）——送滿版 `[REDACTED]` 只會得到編造的根因。
5. **不申請 `Contents: Read`**（D-06，proposed）——待 Q2 拍板。

## Phase 0 發現的內部矛盾（已提交拍板）

| 矛盾 | 位置 | 處置 |
|---|---|---|
| 「深夜提交」場景 vs R5「不得提及非工作時間行為」 | `SC03` | 預設關閉 + 改為陪伴調性；待 Q3 |
| 「三步驟安裝」vs 自架模式的實際步驟數 | §9 檢查表 | 待 Q1 |
| `.prosecutor.yml` 在 private repo 需要的權限 vs R6 | §5 | 待 Q2 |

---

## Agent 呼叫統計

### Phase 0

| 角色 | 模型 | 呼叫次數 | 大致規模 | 產出 |
|---|---|---|---|---|
| tech-lead | sonnet-5 | — | 8 個檔案 | SPEC / TASKS / RISKS / CLAUDE / DECISIONS / BRAND / MEME_SCENES / ARCHITECTURE |
| `architect` | opus-5 (high) | **1**（額度 1/3） | 1 個檔案 | `THREAT_MODEL.md` |
| `builder` | sonnet-5 | 0 | — | — |
| `grunt` | haiku-4.5 | 0 | — | — |
| `redteam` | sonnet-5 | 0 | — | Phase 1 起每 Phase ≥1 |
| `critic` | sonnet-5 | 0 | — | `P0-07` 待執行 |
| `inspector` | haiku-4.5 | 0 | — | `P0-06` 待執行 |
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
