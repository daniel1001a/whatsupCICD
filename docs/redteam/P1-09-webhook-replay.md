# P1-09 — Red Team Round 1: Webhook Signature Verification & Replay/Dedup

**Target:** `src/security/verify-signature.ts`, `src/routes/webhook.ts`, `src/queue/enqueue.ts`,
`src/queue/worker.ts`, `src/db/repositories.ts` (`EventRepository`), `migrations/0001_init.sql`.

**Attacker model:** arbitrary HTTP to `/webhooks/github`; separately, commit access to a watched
repo (can produce arbitrary, legitimately-signed `workflow_run` deliveries by triggering real CI
runs, but does **not** know `GITHUB_WEBHOOK_SECRET`).

**Method:** static reading of every file above, cross-checked against `THREAT_MODEL.md` §5.1–5.3
(the documented design) and `SPEC.md` §4 (the intended event flow), then empirical reproduction
against the real code (not mocks) using `tsx` scripts that import the actual
`buildServer` / `EventRepository` / `createEnqueue` and a real in-memory SQLite DB migrated with
`migrations/0001_init.sql`. No source or test file was modified. Scratch repro scripts lived
outside the repo (`/private/tmp/.../scratchpad/`) and are not part of this report's deliverable.

**Prior round context:** `server.ts` and `routes/webhook.ts` already carry comments referencing
`redteam P1-09 #1` (Slowloris via idle-reset `connectionTimeout`), `#2` (body-size CPU-DoS before
signature check), and `#4` (unsubscribed-event queue dilution) — all three appear fixed and are
listed under "Attempted but held" below with the evidence I checked. This is the first `redteam`
pass on record for this task (`TASKS.yaml` P1-09 status was `todo`), so I did not rely on that
history for anything beyond confirming those three are actually closed.

---

## Findings

### RT1-01 — Run-level replay dedup (`idx_events_run`) is completely inert; delivery_id is the only guard, and it isn't signed

**Severity: Critical**
**Confidence: High** (fully reproduced end-to-end against real production code paths)

**What fails:** `THREAT_MODEL.md` §5.2 mandates three layers of replay defense specifically
*because* `X-Hub-Signature-256` covers only the request body, not headers — meaning
`X-GitHub-Delivery` is attacker-forgeable and cannot be trusted alone. Layer 1 (delivery-id dedup)
is explicitly documented as "idempotency, not security"; Layer 2 (a business key derived from
signed payload content) is documented as **"the primary defense"** against replay precisely
because the attacker cannot alter it without breaking the signature.

In the actual implementation, Layer 2 is `idx_events_run` — `UNIQUE(run_id, run_updated_at) WHERE
run_id IS NOT NULL` in `migrations/0001_init.sql`. But `src/queue/enqueue.ts` (the only production
caller of `EventRepository.insertPending`, wired from `src/routes/webhook.ts`) hardcodes:

```ts
runId: null,
runUpdatedAt: null,
```

on every single call (`src/queue/enqueue.ts` lines 54–55), because the webhook handler is
signature-then-persist by design (R3, 3-second budget) and never parses the payload before
enqueueing. Nothing anywhere in the current codebase performs a later `UPDATE events SET run_id =
..., run_updated_at = ...` — I grepped the whole `src/` tree for `run_id`/`runId` writes and the
only non-null values come from test fixtures calling `EventRepository` directly, never from the
real webhook→enqueue pipeline. Layer 3 (the 15-minute freshness/staleness window on
`workflow_run.updated_at`) does not exist anywhere in the code at all — no timestamp comparison
against `now` occurs in `webhook.ts`, `enqueue.ts`, or `repositories.ts`.

The practical result: **the only replay guard that actually runs today is `delivery_id UNIQUE`,
and `X-GitHub-Delivery` is not covered by the HMAC.** An attacker who obtains *one* legitimately
signed `(body, signature)` pair — via a network capture, a leaked log line, a screenshot of
GitHub's "Recent Deliveries" UI, a compromised CI runner that can see its own triggering webhook,
etc. — can replay that exact pair forever, self-assigning a fresh, never-seen `X-GitHub-Delivery`
UUID on each replay. Each replay: passes signature verification (HMAC only covers the unchanged
body), passes delivery-id dedup (new UUID ⇒ "new" event), and is not touched by run-level dedup
(row is inserted with `run_id = NULL`, so the partial unique index never even sees it). There is
no time bound on this — Layer 3's absence means the exposure isn't capped at 15 minutes as the
threat model intended, it's unbounded.

**Exact reproduction** (verified against real `buildServer`, real `EventRepository`, real
`createEnqueue`, real migrated SQLite — not stubs):

```
1. Build a valid workflow_run.completed payload `body` for installation X, sign it once:
     sig = HMAC-SHA256(body, secret)   // attacker does not need to know `secret` to do this step —
                                         // they only need to have observed one valid (body, sig) pair
2. POST /webhooks/github  headers: { x-hub-signature-256: sig, x-github-delivery: uuid-1, x-github-event: workflow_run }  body
     → 200 { status: "accepted" }
3. POST /webhooks/github  headers: { x-hub-signature-256: sig, x-github-delivery: uuid-2, x-github-event: workflow_run }  body   (same body, same sig, only the delivery id changed)
     → 200 { status: "accepted" }   ← should have been rejected/deduped; wasn't
4. Repeat with uuid-3..N → every single one returns 200 accepted.
```

Actual output from the reproduction script (5 replays of one captured payload):

```
{ deliveryId: 'attacker-forged-uuid-0', status: 200, json: { status: 'accepted' } }
{ deliveryId: 'attacker-forged-uuid-1', status: 200, json: { status: 'accepted' } }
{ deliveryId: 'attacker-forged-uuid-2', status: 200, json: { status: 'accepted' } }
{ deliveryId: 'attacker-forged-uuid-3', status: 200, json: { status: 'accepted' } }
{ deliveryId: 'attacker-forged-uuid-4', status: 200, json: { status: 'accepted' } }
Total accepted rows for the SAME underlying CI run: 5
```

All 5 rows land in `events` with `run_id: null, run_updated_at: null, status: 'pending'` —
indistinguishable from 5 genuinely independent events. Once the Phase 2/3 handler exists, each of
these becomes a full pipeline run: a log fetch, an LLM call (cost), a rendered meme card, and a
Slack post to the victim installation's channel — i.e. exactly the "同一個失敗被反覆宣判，Slack
頻道被同一則公訴書洗版" (the same failure re-adjudicated repeatedly, the channel spammed with the
same verdict) and "每次重放都觸發一次 LLM 呼叫 → 成本放大" (cost amplification) impact that
`THREAT_MODEL.md` §5.2 names as the exact reason Layer 2/3 exist.

**Which control failed and why:** Layer 2/3 of the documented three-layer design were never
implemented in the code path that's actually wired up; only Layer 1 exists, and Layer 1 is
explicitly documented as non-security ("這一層的主要目的是冪等性而非安全"). The gap is not a
subtle logic bug — `runId: null` is written directly in the source, so this is verifiable by
reading `src/queue/enqueue.ts` alone; I confirmed the end-to-end consequence empirically to remove
any doubt.

**Suggested fix direction:** the webhook handler needs to extract at minimum `workflow_run.id` and
`workflow_run.run_attempt` (see RT1-04 below on why `run_attempt`, not `run_updated_at`) from the
JSON body *after* signature verification but *before* enqueueing, and pass them through to
`insertPending`. This does cost a JSON.parse inside the R3 budget, but only after the HMAC gate,
so it doesn't reopen the "parse before verify" hole — it should be fine within the 3-second budget
(JSON.parse of a <1MB payload is sub-millisecond). Add the 15-minute freshness check per Layer 3
at the same point. Until this lands, the run-level and freshness defenses described in
`THREAT_MODEL.md` §5.2 provide **zero** actual protection, regardless of what the schema's index
suggests.

---

### RT1-02 — When run_id *is* eventually populated, a collision on `idx_events_run` throws an uncaught `SqliteError` that `createEnqueue` silently reclassifies as `'unavailable'` (503) instead of `'duplicate'` (200)

**Severity: High** (currently latent/dormant — see confidence note)
**Confidence: High on the mechanism (reproduced directly); Medium on real-world impact, since it only fires once some future code populates `run_id`/`run_updated_at` — which per RT1-01 nothing does yet**

**What fails:** `EventRepository.insertPending` (`src/db/repositories.ts`) does:

```sql
INSERT INTO events (...) VALUES (...)
ON CONFLICT(delivery_id) DO NOTHING
```

The `ON CONFLICT(delivery_id)` clause names a single conflict target (the `delivery_id` unique
constraint). SQLite's upsert syntax only suppresses conflicts on the *named* arbiter — a conflict
on a *different* unique index (here, `idx_events_run`) is not covered by this `DO NOTHING` and
raises a normal constraint-violation exception instead.

`createEnqueue` (`src/queue/enqueue.ts`) wraps the call in a blanket `try { ... } catch { return
'unavailable'; }`. So a run-level idempotency collision — which is a *deterministic, expected,
non-error condition* (the same run really was delivered twice) — gets funneled into the same path
as "the DB is actually down," and `webhook.ts` turns `'unavailable'` into a `503`. GitHub
interprets 503 as "please retry," but retrying changes nothing: the retried request has the same
run content, so it will deterministically hit the same `idx_events_run` conflict again. This
either burns through GitHub's redelivery attempts for a request that was in fact already handled
correctly the first time (misclassifying success-via-idempotency as failure), or, if this is a
brand-new run whose `run_id`/`run_updated_at` happens to collide with an existing row for an
unrelated reason, it masks a real data problem behind a generic "queue unavailable" log line.

**Exact reproduction** (direct call to `EventRepository.insertPending`, the real class, real
migrated SQLite):

```
1. insertPending({ deliveryId: 'delivery-A', runId: 999, runUpdatedAt: 'T1', ... })
   → 'accepted'
2. insertPending({ deliveryId: 'delivery-B' (new!), runId: 999, runUpdatedAt: 'T1' (same), ... })
   → THROWS: SqliteError: UNIQUE constraint failed: events.run_id, events.run_updated_at
     (err.code === 'SQLITE_CONSTRAINT_UNIQUE')
3. Wrapping step 2 in createEnqueue's exact try/catch pattern → returns 'unavailable', i.e. what
   webhook.ts turns into a 503.
```

No test in `src/queue/enqueue.test.ts`, `src/db/db.test.ts`, or `src/queue/worker.test.ts` exercises
this collision path — all `run_id`/`run_updated_at` values used in those files are deliberately
distinct per the comment at `src/db/db.test.ts:57-58` ("每次呼叫用不同的 run_id，避免撞到
`idx_events_run`"), which means the collision-handling behavior has never been observed by the
test suite, let alone asserted on.

**Why this matters despite being dormant today:** it's a design flaw in the same statement that's
supposed to become the primary replay defense (RT1-01's suggested fix). If the fix for RT1-01 is
implemented by naively adding `runId`/`runUpdatedAt` to the existing `insertPending` call, this
bug activates immediately and turns every legitimate duplicate-run delivery into a 503/retry loop
instead of the intended 200/no-op. This is exactly the kind of thing that should be caught before,
not after, RT1-01 is fixed.

**Suggested fix direction:** either (a) add a second `ON CONFLICT` arbiter/handling for
`idx_events_run` (SQLite doesn't support multiple `ON CONFLICT` targets in one clause the way some
engines do — one option is a `SELECT ... WHERE run_id = ? AND run_updated_at = ?` existence check
inside the same transaction before the INSERT, still racy-safe because SQLite serializes writers,
or catch the specific `SQLITE_CONSTRAINT_UNIQUE` on the `idx_events_run` index by inspecting
`err.message`/`err.code` and returning `'duplicate'` instead of swallowing into `'unavailable'`);
or (b) at minimum, have `createEnqueue`'s catch block distinguish `SqliteError` with
`code === 'SQLITE_CONSTRAINT_UNIQUE'` from genuine I/O/availability failures, and map the former to
`'duplicate'` rather than `'unavailable'`.

---

### RT1-03 — No per-installation rate limiting, no bounded queue depth: a single watched repo can starve every other tenant's queue

**Severity: Medium**
**Confidence: High** (absence confirmed by exhaustive grep; consequence follows directly from the global-FIFO `claimNext` query)

**What fails:** `THREAT_MODEL.md` §5.3(d) states flatly: "每 installation 速率限制... 這是多租戶
系統的基本要求" (per-installation rate limiting is a basic requirement of a multi-tenant system),
specifying a token bucket of 20 events/min with a 40 burst, keyed by installation id, and §5.3(c)
requires a bounded queue depth (100) with shed-on-full behavior. Neither exists anywhere in the
current code — I grepped `src/` for `rate.?limit` (case-insensitive) and found zero matches
outside a single explanatory comment in `webhook.ts` that describes the *intent* without any
enforcing code. There is no cap on the `events` table's size and no shed-load path.

`EventRepository.claimNext` (`src/db/repositories.ts`) is a single **global** FIFO:

```sql
SELECT id FROM events
WHERE status IN ('pending', 'failed') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
ORDER BY received_at ASC
LIMIT 1
```

There is no `installation_id` partitioning, weighting, or fairness of any kind. The attacker model
for this task explicitly includes "commit access to a watched repo" — that's sufficient, with zero
knowledge of the webhook secret, to generate unlimited *correctly signed* `workflow_run` events
(script `workflow_dispatch` calls in a loop, or fan out many parallel failing PR builds). Every one
of those events is legitimate per the signature check and per `SUBSCRIBED_EVENTS`/`isGitHubEventType`
filtering (the #4 fix from the prior round only filters *event type*, not *volume*), so they all
land in the shared queue and get processed strictly in arrival order ahead of any other tenant's
events that arrived later. This is a classic noisy-neighbor DoS in a stated-multi-tenant system,
and it costs the attacker nothing but their own CI minutes.

**Reproduction (by inspection, not run against a live multi-tenant deployment):** any sequence of
N legitimately-signed `workflow_run` deliveries for installation A, interleaved with a small number
of deliveries for installation B arriving later, will result in `claimNext` draining all of A's
backlog before B's events are ever picked up, with no code path anywhere that would prevent or even
detect this beyond the (missing) rate limiter this section is about.

**Suggested fix direction:** implement the token-bucket rate limiter and queue depth cap
`THREAT_MODEL.md` §5.3(c)/(d) already specifies (they're detailed enough to implement directly —
20/min, burst 40, per `installation_id`, reject-and-count over `queue_shed_total`), and consider
partitioning or round-robin scheduling in `claimNext` by `installation_id` so one tenant's backlog
can't fully starve another's even before the rate limiter engages.

---

### RT1-04 — `idx_events_run` keys on `(run_id, run_updated_at)`, but `THREAT_MODEL.md` §5.2 specifies `(run_id, run_attempt)` — and `run_attempt` doesn't exist anywhere in the schema

**Severity: Low**
**Confidence: Medium** (a real spec/implementation divergence; the practical exploitability depends on GitHub's actual `updated_at` granularity and delivery patterns, which I did not independently verify against live GitHub behavior)

**What fails:** `THREAT_MODEL.md` §5.2 Layer 2 specifies the idempotency key as
`(workflow_run.id, workflow_run.run_attempt)` specifically because `run_attempt` is a stable,
monotonically-incrementing integer per re-run, whereas `updated_at` changes across every lifecycle
transition (`queued` → `in_progress` → `completed`) *within the same attempt*. `migrations/0001_init.sql`
instead defines `idx_events_run` on `(run_id, run_updated_at)`, and `run_attempt` does not appear
anywhere in `src/types/events.ts`, `src/types/db.ts`, or the `events` table schema — it was never
modeled at all.

Two failure directions follow, both currently unreachable in practice only because of RT1-01
(nothing populates these columns yet), which is exactly why this is worth recording now, before
the RT1-01 fix locks in the wrong key:
- **Under-deduping across genuinely duplicate attempts:** if GitHub (rarely, but documented as
  possible) redelivers a `completed` event for the same attempt with a slightly different
  `updated_at` (sub-second reprocessing, clock skew on GitHub's side, etc.), the current key would
  treat them as distinct and fail to dedupe — the exact case Layer 2 exists to catch.
- **Over-deduping across legitimate re-runs:** if a user re-runs a failed job and the new attempt's
  `completed` timestamp happens to land in the same second as a previous attempt's (low
  probability but not zero at second-granularity), a genuinely new attempt could be silently
  dropped as a "duplicate," which would be a real R4 violation (silent event loss) once this key is
  live.

**Suggested fix direction:** add `run_attempt` to the `events` schema and switch
`idx_events_run`'s key to `(run_id, run_attempt)` as `THREAT_MODEL.md` specifies, sourced from
`workflow_run.run_attempt` in the payload. This should be bundled with the RT1-01 fix rather than
done separately, since both require the same payload-parsing step.

---

## Attempted but held (verified as correctly defended)

For each: what I tried, and the evidence it's actually covered — not just "there's a test for it."

- **Missing signature header → 401, not skipped.** `verify-signature.ts` checks
  `header === undefined || header.length === 0` before anything else (after the secret check) and
  returns `missing_header`; `webhook.ts` maps any non-ok verdict to 401 before touching
  `enqueue`. Confirmed by direct code read plus `tests/e2e/webhook.test.ts` ("缺少簽章標頭 →
  401").
- **Empty/misconfigured secret fails closed, doesn't disable verification.** `secret.length === 0`
  is checked *first*, before the header is even inspected, and returns `secret_not_configured`
  (still a 401 to the client). In production, `src/config/env.ts`'s `REQUIRED_IN_PRODUCTION` list
  includes `GITHUB_WEBHOOK_SECRET`, so `loadEnv` throws at startup if it's unset when
  `NODE_ENV=production` — an empty-secret bypass is not reachable in a real deployment.
- **`sha1=` / algorithm confusion.** `PREFIX = 'sha256='`; anything else with an `=` is
  `unsupported_algorithm`, anything without is `malformed_header`. Both fail closed regardless of
  whether the SHA-1 digest would otherwise "match" some legacy value.
- **Bare hex digest without a `sha256=` prefix.** Explicitly rejected (`malformed_header`) — tested
  and confirmed in `verify-signature.test.ts`.
- **Non-timing-safe comparison / timing side channel on the secret.** Uses
  `crypto.timingSafeEqual`, with an explicit length check *before* calling it (avoiding the throw
  `timingSafeEqual` raises on length mismatch, which would itself be a minor timing tell). I did
  not find any code path where a byte-by-byte guess of the correct HMAC would produce a measurable
  timing difference.
- **Signature over re-serialized JSON vs. raw bytes.** `registerWebhookRoutes` registers a
  content-type parser with `parseAs: 'buffer'` that does *no* JSON parsing before the handler runs;
  the handler passes that exact `Buffer` into `verifyGitHubSignature` and only ever hands the raw
  buffer onward (`IncomingEvent.rawBody`). Confirmed both by reading the code (no
  `JSON.parse`/`JSON.stringify` occurs anywhere upstream of verification) and by the whitespace-
  sensitivity test in both `verify-signature.test.ts` and `tests/e2e/webhook.test.ts` ("交給
  enqueue 的是原始位元組，不是重新序列化的結果").
- **Duplicate `x-hub-signature-256` headers (Fastify gives an array).** `headerValue()` returns
  `undefined` for anything that isn't a `string`, which routes straight into the
  `missing_header` → 401 path. Confirmed by code read and by
  `tests/e2e/webhook.test.ts` ("簽章標頭重複出現時視為缺失 → 401").
- **Case sensitivity of the hex digest.** Uppercase hex digests are explicitly accepted
  (`provided.toLowerCase()` before comparison) since GitHub's spec doesn't guarantee case — this is
  intentionally permissive and not exploitable (it doesn't weaken the comparison, since the
  regex-validated character class `[0-9a-f]{64}` case-insensitive still requires exact digest
  match after normalization).
- **Non-hex characters in a 64-char digest string.** Explicitly rejected via regex before any
  `Buffer.from` conversion, specifically to avoid silently-truncated/garbage bytes being compared
  and misclassified as an ordinary `mismatch`.
- **Same `delivery_id` replayed twice.** Correctly idempotent — second call returns `'duplicate'`,
  `webhook.ts` returns 200, and I confirmed via direct SQL that only one row exists
  (`enqueue.test.ts` and my own repro both agree). This is genuinely solid *for literal
  byte-for-byte replays with the same delivery_id* — the gap is specifically that this is the
  *only* layer that runs (RT1-01).
- **Concurrent duplicate `delivery_id` race (TOCTOU).** `insertPending` uses a single atomic
  `INSERT ... ON CONFLICT(delivery_id) DO NOTHING` statement rather than
  select-then-insert. better-sqlite3 executes synchronously and SQLite serializes all writers
  (even across OS processes, via file locking) — there is no window between a conflict check and
  the write for two concurrent requests to both "win." I did not additionally build a
  multi-process race harness since the atomicity is structural (single SQL statement), not
  behavioral; verified by code reading rather than a timing experiment.
- **Oversized body (CPU-DoS via unauthenticated HMAC computation).** `bodyLimit: 512 * 1024` is
  set on the Fastify instance itself (`server.ts`), so oversized requests are rejected with 413
  before any parser or handler code — and therefore before `createHmac().update()` ever runs.
  Confirmed via `tests/e2e/webhook.test.ts` ("超過 body 上限 → 413，且不計算 HMAC"), which is
  labeled as a fix for a prior round's finding (`redteam P1-09 #2`); the server.ts comment cites a
  concrete empirical basis (15 concurrent 2MB requests degrading `/healthz` from ~2ms to ~145ms)
  for the 512KB choice. I did not re-run that specific load test; I verified the configuration and
  the 413-before-HMAC ordering are in place as claimed.
- **Slowloris / idle-reset timeout gap.** `connectionTimeout` alone is idle-reset (any byte resets
  it), which a trickle attack defeats; `server.ts` now also sets `requestTimeout: 5_000` (Node's
  absolute, non-resetting request timeout), closing that gap. This is documented as a fix for
  `redteam P1-09 #1`; I did not re-run a trickle-attack timing test, but the code change
  (`requestTimeout` addition) directly addresses the documented mechanism.
- **Unsubscribed event types diluting processing quota.** `SUBSCRIBED_EVENTS` filters by header
  only (no body parse) before enqueueing, so a correctly-signed `push` or any other unsubscribed
  event type returns 200/skipped without ever reaching `enqueue`. Confirmed in code and by
  `tests/e2e/webhook.test.ts` ("未訂閱的事件類型 → 200 skipped，不進佇列"). Note this only
  addresses *event-type* dilution — it does **not** address *volume* dilution from subscribed event
  types, which is RT1-03.
- **Filter-before-verify leak (learning what's subscribed without a valid signature).** Confirmed
  the event-type filter runs strictly after signature verification — an unsubscribed event type
  with a bad signature returns 401, not 200/skipped, so an attacker can't fish for which event
  types are subscribed without already having a valid signature.
- **`enqueue()` throwing synchronously or asynchronously.** `webhook.ts` wraps the `await
  deps.enqueue(...)` call in try/catch and returns 503, never 500 and never a silent 200 (R4).
  Confirmed by `tests/e2e/webhook.test.ts` ("enqueue 拋錯 → 503") and by reading the handler.
- **`enqueue` not wired at all.** `buildServer`'s default `enqueue` (used when
  `main.ts` doesn't supply one) explicitly logs and returns `'unavailable'` rather than silently
  accepting and dropping events — R4-compliant fail-closed default. Worth noting operationally:
  `src/main.ts` currently calls `buildServer({ env })` **without** passing `enqueue` at all, so as
  deployed today (before some future wiring task), every webhook request — valid or not — gets a
  503. This makes RT1-01/RT1-02 currently unreachable *in the running server*, but both are fully
  reachable in the `enqueue.ts`/`repositories.ts` code that's already merged and will go live the
  moment that wiring lands, which per `STATE.md` is the very next task ahead of this one (P1-06).

---

## Summary

| ID | Severity | Confidence |
|---|---|---|
| RT1-01 | Critical | High |
| RT1-02 | High | High (mechanism) / Medium (current impact — dormant until run_id is populated) |
| RT1-03 | Medium | High |
| RT1-04 | Low | Medium |

No findings were invented to pad this report — RT1-01 in particular was verified with a full
end-to-end reproduction against real production code (not a mock), included above. The signature
verification module itself (`verify-signature.ts`) held up against every bypass technique I tried;
every real gap I found is downstream of it, in the replay/dedup and multi-tenancy layers.

---

## Tech Lead triage (2026-08-01)

| ID | Disposition |
|---|---|
| RT1-01 | **Fixed.** `migrations/0002_run_attempt.sql` adds `run_attempt`; `enqueue.ts` now parses `workflow_run.id`/`run_attempt`/`updated_at` post-signature-verification (still bytes-in-memory only, R2-compliant) and passes the real idempotency key through to `insertPending`. Layer 3 (15-min freshness window) implemented in the same pass — new `'stale'` outcome. Re-ran the exact 5-replay reproduction from this report against the real built server (`app.inject`, real `EventRepository`, real migrated SQLite): now 1 `accepted` + 4 `duplicate`, 1 row in `events` (was 5/5). Regression tests: `src/queue/enqueue.test.ts` (7 new cases: forged-delivery replay, run_id/run_attempt persisted, legit-rerun not over-deduped, stale rejection, in-window acceptance, malformed-body graceful degrade). |
| RT1-02 | **Fixed** in the same change. `EventRepository.insertPending` now catches the `idx_events_run`-specific `SQLITE_CONSTRAINT_UNIQUE` (matched on `err.code` + both column names in `err.message`, verified empirically against better-sqlite3's actual error shape) and returns `'duplicate'` instead of letting it propagate into `createEnqueue`'s catch-all → `'unavailable'` → 503-retry-loop. Any other constraint violation still propagates untouched. Regression tests: `src/db/db.test.ts` (2 new cases: collision returns `duplicate` without throwing; distinct `run_id`/`run_attempt` pairs both succeed). |
| RT1-03 | **Not fixed now — deferred to Phase 4 (`P4-01`), which already scopes "webhook 端有 per-installation 限流".** This is a real gap (confirmed by inspection) but not a Gate P1 requirement (`CLAUDE.md`'s Phase 1 gate is `npm run dev` boots, CI four-gates, signed-webhook <3s/200, ≥8 fixtures — no rate-limiting clause), and the project is pre-launch/self-hosted single-tenant in practice until Phase 5. Flagged to PO in the Phase 1 report; not silently dropped. |
| RT1-04 | **Fixed** as part of the RT1-01 change — `idx_events_run` now keys on `(run_id, run_attempt)` per `THREAT_MODEL.md` §5.2, not `(run_id, run_updated_at)`. |

**Also fixed, adjacent but necessary for the above to be reachable at all:** `src/main.ts` never
passed `enqueue` to `buildServer` — every webhook request against the actual running server (built
via `npm run build && npm start`) was unconditionally getting `'unavailable'`/503 regardless of
this report's findings, per the "Attempted but held" note above. Wired a real `EventRepository`
+ `createEnqueue` into `main.ts` (DB connection only; migrations still applied via the existing
`npm run migrate` step, not auto-run on boot). Did **not** wire the `Worker` — no real
`EventHandler` exists before Phase 2, and draining the queue with a stub handler would silently
mark events `done` without processing them, which is a worse R4 violation than not draining at all.

All four CI gates (`typecheck`/`lint`/`test`/`build`) green on the combined change; full suite at
151/151 (142 previously + 9 new regression tests targeting these findings specifically).
