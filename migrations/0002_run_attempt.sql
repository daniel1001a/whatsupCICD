-- migrations/0002_run_attempt.sql
--
-- P1-09 redteam（RT1-01 / RT1-04）修補：THREAT_MODEL.md §5.2「層 2 — 業務層冪等鍵」
-- 明訂鍵是 (workflow_run.id, workflow_run.run_attempt)——run_attempt 是每次重跑
-- 單調遞增的穩定整數。0001_init.sql 的 idx_events_run 誤用了 (run_id, run_updated_at)：
-- updated_at 在同一個 attempt 的生命週期轉換（queued → in_progress → completed）之間
-- 就會變動，拿它當鍵會在同一 attempt 內錯誤地不去重；反過來，兩個不同 attempt 的
-- completed 時間戳若剛好落在同一秒，也會把一次合法重跑錯誤地當成重複丟棄（R4 違反：
-- 靜默漏處理事件）。詳見 docs/redteam/P1-09-webhook-replay.md RT1-04。
--
-- run_id 為 NULL 的列（webhook handler 尚未解析 payload、或非 workflow_run 事件）
-- 不受這個唯一索引約束，維持與 0001 相同的 partial-index 語意。

ALTER TABLE events ADD COLUMN run_attempt INTEGER;

DROP INDEX idx_events_run;

CREATE UNIQUE INDEX idx_events_run ON events(run_id, run_attempt) WHERE run_id IS NOT NULL;
