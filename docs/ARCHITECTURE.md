# ARCHITECTURE.md

> **狀態**：Phase 0 骨架。事件流與兩個「為什麼」已定稿；sanitizer 設計細節與
> 場景選擇邏輯於 Phase 2/3 實作後補完；正式圖表於 Phase 5 完稿（P5-03）。

---

## 1. 事件流

完整 ASCII 圖見 `SPEC.md` §4。摘要：

```
GitHub ──webhook──▶ ① 驗簽・去重・落庫・回200  ──▶ 200 (< 500ms)
                          │
                          ▼ (非同步)
                    ② 讀設定 → ③ 抓log → ④ 清洗 → ⑤ SANITIZE
                          → ⑥ 錯誤擷取 → ⑦ LLM → ⑧ fallback?
                          → ⑨ 迷因卡 → ⑩ Slack → ⑪ 落庫
```

**同步邊界只有一個**：webhook handler。它只做四件事——驗簽、去重、落庫、回 200。
其餘全部在 worker 裡跑。

**確定性邊界**：④⑤⑥⑨ 的場景選擇全部是純函式，同輸入同輸出，可測試可重現。
只有 ⑦（LLM 產文）與 ⑨ 的標題生成是非確定性的，且兩者的輸出都經過
schema 驗證與伺服器端夾制才會進入渲染。

---

## 2. 為什麼非同步

GitHub 對 webhook 的容忍時間是 **10 秒**，超時標記投遞失敗並重送。

我們的管線包含至少三次外部網路往返：

| 步驟 | 典型延遲 | P95 |
|---|---|---|
| 下載 job log | 0.5–3 s | 8 s |
| 呼叫 LLM | 2–5 s | 12 s |
| 渲染 PNG | 0.1–0.5 s | 1 s |
| 投遞 Slack（含上傳檔案） | 0.3–1 s | 3 s |

P95 合計約 **20–40 秒**。同步處理必然逾時 → GitHub 重送 → 我們重複處理 →
使用者收到重複判決書。這是 R3 的技術根據，不是偏好。

**非同步的代價與對策**

| 代價 | 對策 |
|---|---|
| 事件可能在處理中遺失 | 回 200 **之前**已寫入 `events` 表；開機掃描 `processing` 孤兒重排 |
| 需要 queue 元件 | in-process queue + `events` 表當持久層。**不上 Redis/BullMQ**，理由見 `DECISIONS.md` D-01 |
| 使用者要等 | 目標 P95 ≤ 45 秒。CI 失敗的心理預期本來就不是即時 |

---

## 3. 為什麼原始 log 不落地（R2）

原始 CI log 是本專案接觸到的**最敏感的資料**。它可能包含環境變數傾印、
資料庫連線字串、內網拓撲、雲端憑證。

一旦寫入磁碟，三件事會立刻發生：

1. **它會被複製。** 備份、快照、Fly.io volume、error tracker 的 crash dump、
   容器映像層——每一個都是新的外洩面，而且都不在我們的直接控制下。
2. **我們就必須回答那些問題。** 「你們存了多久？誰能看？怎麼刪？合規嗎？」
   而正確且唯一有說服力的答案應該是：**我們根本沒存。**
3. **爆炸半徑升級。** 一次資料庫外洩就從「我們的服務掛了」變成
   「我們外洩了客戶的生產環境憑證」。第一種可以道歉，第二種不行。

### 原始 log 的生命週期

```
GitHub storage
   │ HTTPS 串流（有硬性大小上限，超過只留尾端）
   ▼
記憶體 buffer ──▶ 清洗 ──▶ SANITIZE ──▶ 錯誤擷取 ──▶ 送 LLM
   │                                                      │
   └──────────────────── buffer 釋放 ◀────────────────────┘

全程：無檔案 · 無 DB · 無 log 輸出 · 無 error report
```

### 落庫的東西（只有這些）

| 欄位 | 內容 |
|---|---|
| `verdict_json` | 公訴詞——**已遮罩、已通過出站健檢** |
| `signature_hash` | 錯誤簽章的 SHA-256，用於累犯偵測。**單向，無法還原** |
| `window_start_line` / `window_end_line` | 錯誤區段的**行號**，不是內容 |
| `error_class` / `severity` / `confidence` / `redaction_ratio` | metadata |
| `payload_digest` | webhook raw body 的 SHA-256，除錯用。**不存 payload 本體** |
| `slack_user_hash` | Slack user id 的 HMAC。**不存明文** |

### 三個容易被忽略的外洩路徑（Phase 4 必須有測試守住）

1. **日誌的日誌**：pino 若序列化了錯誤區段物件，log 檔就等於落地了。
   → pino redaction 明列禁止欄位 + 測試證明。
2. **例外訊息**：管線中途拋出的例外，其 `message` 或 `stack` 可能夾帶原始內容，
   然後被送進 error tracker。 → error reporter 上 scrubbing hook。
3. **解壓縮暫存檔**：log 下載是壓縮的。若用「先寫檔再解壓」的實作，
   就落地了。 → 串流解壓，全程不產生暫存檔。

---

## 4. Sanitizer 設計

> Phase 2 實作後補完。目前的設計約束：

- **獨立模組**：`src/sanitizer/` 零外部依賴、不 import 專案內其他模組
  （預留項 (a)：之後要抽成獨立套件）。
- **分層**：結構化/多行 pattern（PEM 區塊、env 傾印）→ 行級 regex → 熵值分析。
  順序不可調換，否則多行秘密會被行級規則切碎後漏掉。
- **Fail-closed**（D-11）：拋錯、逾時（2 秒預算）、設定載入失敗 → 不呼叫 LLM，
  走 R4 模板 fallback。
- **出站前置健檢**：一層**獨立實作**的高訊號掃描（`AKIA` / `-----BEGIN` /
  `ghp_` / `xox` / `sk-`…），刻意與前面的規則重複。防禦縱深在這裡的意義
  就是重複。
- **ReDoS 防護**：所有 pattern 禁用巢狀量詞與無界 `.*`，CI 上 `safe-regex` 靜態檢查。
- **遮罩率回報**：> 25% 夾制 confidence，> 40% 直接不呼叫 LLM（D-12）。

完整的敏感資訊分類、偵測策略與紅隊結果見 `THREAT_MODEL.md`。

---

## 5. 迷因場景選擇邏輯

> Phase 3 實作後補完。目前的設計約束：

- 選擇函式的**輸入全部是確定性離散特徵**——error_class、伺服器計算的 severity、
  repeat_tier、時間旗標、以及**已被夾制成 enum** 的 confidence。
  沒有任何 LLM 自由文字進入這個函式。
- 規則存於 `scenes/rules.json`（priority-ordered，first-match-wins），
  開機時經 JSON Schema 驗證，並強制檢查最後一條為無條件 catch-all。
- **程式碼不含任何場景 ID 字面量**（D-04 / 預留項 (c)）。
- 特徵空間可窮舉（約 10⁵ 組），測試以笛卡兒積驗證每組恰好命中一個場景。

這個設計讓 Gate P3 的「同輸入同輸出」從一個需要人肉確認的性質，
變成一個 schema 加測試就能保證的性質。

---

## 6. 為什麼 severity 由伺服器算而不是 LLM

見 `DECISIONS.md` D-03。兩個理由：

1. 量刑是本產品最容易被讀成「對人的評價」的欄位，不能交給一個
   會被 prompt injection 影響的元件決定（R5）。
2. 場景選擇必須確定性（Gate P3），而場景選擇需要 severity。

LLM 的 `severity_opinion` 仍然收集落庫，作為「我們的規則跟模型判斷差多少」
的免費校準訊號。

---

## 7. 未來擴充的三個接縫

| 接縫 | 實作方式 | 觸發時機 |
|---|---|---|
| (a) sanitizer 抽成獨立套件 | `src/sanitizer/` 零依賴、不 import 專案內模組 | 有第二個專案要用時 |
| (b) CI 供應商 adapter | `CiAdapter` 介面，`GitHubAdapter` 是唯一實作。核心管線只認介面 | 要支援 GitLab 時 |
| (c) 場景庫資料驅動 | `scenes/*.scene.json` + `scenes/rules.json`，程式碼不含場景字面量 | 要做團隊自訂場景時 |

另有一個未列為正式接縫但已隔離的：**`Queue` 介面**。
單機吞吐不足或需要多實例時，換掉唯一的 in-process 實作即可（D-01）。
