# CI Log Fixtures

This directory contains **generated, but fictional and realistic**, GitHub Actions
failure logs for testing the Build Failure Prosecutor's error extraction and
sanitization pipeline (SPEC.md §6).

## Generated, not hand-crafted

Every file in `ci-logs/` and `manifest.json` itself is produced by
[`generate.py`](./generate.py) — a pure-stdlib Python script with **no
dependencies**. **Do not hand-edit `ci-logs/*.log` or `manifest.json`.** If a
fixture needs to change (different anchor position, more noise, a new
language), change its config in `generate.py` and rerun:

```bash
cd fixtures
python3 generate.py
```

This is deliberate, not incidental: an earlier hand-maintained version of
these fixtures drifted out of sync with its own manifest, and a version
before that collapsed into ten files sharing one identical geometry (same
line count, same anchor offset, same ANSI/group counts) — which meant the
extractor's window/anchor/compression logic was effectively tested against
one shape, ten times. Generating them from config, with the manifest
computed (never hand-typed) from the same run that wrote the log, makes both
mistakes structurally impossible: the anchor line the script asserts while
building a file *is* the line number written to disk.

The script is deterministic: every fixture is built with
`random.Random(<filename>)`, so re-running `generate.py` always reproduces
byte-identical output. Commit the script; don't commit divergence between it
and its output.

## Why this design

Each fixture targets a **specific geometry**, not just "a plausible log in
language X". See the table below — every column varies deliberately across
files, because the estimated value of a fixture set is in the diversity of
shapes it forces the extractor to handle, not in the count of files:

- **Total lines** and **anchor position** (as a fraction of the file) vary
  per file, including two intentionally degenerate cases: the anchor 37
  lines from the start (`03`) and 22 lines from the end (`02`), so the
  extractor's 30-before/80-after window is forced to handle "not enough
  lines available" on both sides.
- **ANSI escape density** is different in every file (15–120 occurrences),
  mixing SGR color codes, clear-line/cursor-movement sequences, and (in
  `05-rust-cargo.log`) one OSC title-set sequence.
- **`##[group]`/`##[endgroup]` count** differs per file (3–9), and the real
  error always falls inside the *last* group, per SPEC.md §6.2's "search the
  last group first" rule.
- **`09-eslint-lint.log`** carries a genuine cascade: 190 near-identical
  `error ... no-xxx` lines, to exercise the cascade-penalty / "pick the
  first occurrence, not the last" logic.
- **`11-oversized-webpack.log`** is 2600 lines and engineered so that the
  30-before/80-after window *by itself* is already >4k estimated tokens
  (minified-bundle-length lines, base64 blobs, 40 `node_modules/` stack
  frames within the window) — this is the only fixture that exercises the
  §6.4 C1–C7 compression ladder.
- **`12-no-signature.log`** has **no Tier A/B/C error pattern anywhere** —
  the job just exits 1. This is the §6.5 fallback-path fixture:
  `anchor_line: null`, `expected_signature_found: false`. The only
  recognizable string in the whole file is the mandatory tail anti-anchor
  (`##[error]Process completed with exit code 1`), which the extractor must
  *not* mistake for a real signature.

## What every fixture contains

- **GitHub Actions metadata**: monotonically increasing ISO-8601 timestamp
  prefixes (`2026-03-14T08:21:33.4821994Z `) on ≥90% of lines,
  `##[group]`/`##[endgroup]` markers, `##[error]` lines
- **ANSI escape sequences** for realism (see above)
- **Realistic noise**: checkout/setup/cache chatter, ≥3 distinct
  `npm WARN deprecated <pkg>@<ver>` lines, `Post job cleanup`, progress-bar
  redraws
- **Language-specific error sections** preserved from the previous fixture
  generation (TS2339, pytest `AttributeError`, Rust `E0308`, npm `ERESOLVE`,
  etc.) but now surrounded by realistic, per-file stack traces / diagnostics
  instead of generic filler
- **Anti-anchor**: `##[error]Process completed with exit code 1` in the last
  5 lines of every file — the extractor must not select this as the primary
  error (SPEC.md §6.2, Tier D)
- **Seeded fake secrets**: ≥2 fake-credential categories per file (3 in
  `11`), for sanitizer testing

### Seeded fake secrets

All secrets are **deliberately fake** and drawn from a small fixed set of
categories (see `SECRET_LINES` in `generate.py`):

| Category | Example value |
|---|---|
| `aws_access_key` | `AKIAIOSFODNN7EXAMPLE` (official AWS example key) |
| `db_connection_string` | `postgres://ciuser:hunter2@db.internal.example.com:5432/appdb` |
| `fs_path_runner` | `/home/runner/work/whatsupCICD/whatsupCICD` |
| `fs_path_mac` | `/Users/testuser/Library/Caches/pip/wheels` |
| `internal_ip` | `10.0.3.42` |
| `bearer_token` | `Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fake.signaturepayload` |

**None of these are real or functional.** They exist solely so the sanitizer
redteam suite has known-bad strings to detect.

## Fixture overview

| File | Language | Framework | Error Class | Lines | Anchor | What it specifically tests |
|---|---|---|---|---|---|---|
| `01-typescript-tsc.log` | TypeScript | tsc | E_COMPILE | 320 | 240 | Standard case: full 30/80 window available on both sides |
| `02-jest-test-failure.log` | JavaScript | Jest | E_TEST | 190 | 168 | Anchor near the **end**: only 22 lines after — "after 80 insufficient" |
| `03-python-pytest.log` | Python | pytest | E_TEST | 260 | 38 | Anchor near the **start**: only 37 lines before — "before 30 insufficient" |
| `04-go-build-test.log` | Go | go test | E_COMPILE | 210 | 145 | Standard case, error tight against the last group's boundaries |
| `05-rust-cargo.log` | Rust | cargo | E_COMPILE | 480 | 300 | Long file, window far from either edge; carries the one OSC escape |
| `06-java-maven.log` | Java | Maven | E_COMPILE | 240 | 150 | ≥40-line stack trace with third-party frames, for §6.4 C4 folding |
| `07-npm-dependency.log` | JavaScript | npm | E_DEPENDENCY | 175 | 120 | Standard case |
| `08-docker-build.log` | Dockerfile | Docker/BuildKit | E_NETWORK | 230 | 160 | Standard case |
| `09-eslint-lint.log` | JavaScript | ESLint | E_LINT | 900 | 700 | Cascade: 190 same-shape `error ... no-xxx` lines; anchor is the *first*, not last |
| `10-infra-timeout.log` | Shell | Docker orchestration | E_TIMEOUT | 200 | 130 | Infra/timeout failure, not a code defect |
| `11-oversized-webpack.log` | JavaScript | webpack | E_COMPILE | 2600 | 1900 | 30/80 window alone >4k tokens; ≥30 `node_modules/` frames in-window — the only §6.4 C1–C7 test source |
| `12-no-signature.log` | Shell | unknown | E_UNKNOWN | 150 | *(none)* | §6.5 fallback path: zero recognizable error signature anywhere |

## Ground truth file: `manifest.json`

Fully generated by `generate.py` in the same run that writes the logs.
Each entry has:

- `anchor_line` — 1-indexed line number of the primary error, or `null` for
  `12-no-signature.log`. **Computed by the script**, never hand-typed.
- `anchor_text` — the exact rendered line at that position (including its
  timestamp prefix), so any consumer can assert `anchor_text in line`.
- `total_lines` — actual line count of the generated file.
- `expected_error_class` — one of `E_COMPILE`, `E_TEST`, `E_DEPENDENCY`,
  `E_LINT`, `E_TIMEOUT`, `E_OOM`, `E_NETWORK`, `E_AUTH`, `E_INFRA`,
  `E_DEPLOY`, `E_UNKNOWN`
- `seeded_secrets` — fake-credential categories planted in that file
- `expected_signature_found` — present and `false` only on
  `12-no-signature.log`

## Changing or adding a fixture

1. Open `generate.py` and find `build_fixture_configs()` (or
   `build_oversized_config()` for `11`, or the `no_signature=True` entry for
   `12`).
2. Edit the config (target `total`, `anchor`, `groups`, `ansi`, `secrets`,
   the language-specific `before_immediate`/`after_immediate` content, etc.)
   or add a new dict to the list.
3. Rerun `python3 generate.py` from inside `fixtures/`.
4. Update the table in this README if you changed the geometry or added a
   file.
5. Run the verification checklist below.

Do not aim for ten files that look alike. The whole point of this fixture
set is that no two files share the same total-line-count, anchor-position,
ANSI-density, or group-count combination — pick numbers that are actually
different from what's already in the table.

## Verification checklist

```bash
cd fixtures
python3 generate.py   # regenerate everything from config

# Validate JSON + spot-check every row against its target geometry
python3 - <<'PY'
import json
d = json.load(open('manifest.json'))
for f in d['fixtures']:
    p = 'ci-logs/' + f['file']
    total = len(open(p, encoding='utf-8').readlines())
    ok_total = total == f['total_lines']
    print(f"{f['file']:28} lines={total:5} anchor={f.get('anchor_line')} {'OK' if ok_total else 'MISMATCH'}")
PY
```

For the full Phase-2 acceptance gate (per-file geometry bounds, distinct
ANSI/group counts across the set, the ESLint cascade count, and the
oversized-webpack token estimate), see the DoD block in the P1-07 task —
it runs the same three checks CI will eventually run.

## Used by

- **Phase 2 testing**: Error extraction validation across languages and
  file geometries
- **Phase 2 testing**: Sanitizer testing (do we mask all seeded secrets
  correctly, at every noise density?)
- **Phase 4 testing**: Rate-limit + fallback scenarios (`12`'s no-signature
  path exercises the same code path as a fetch failure)
- **Documentation**: Architecture examples in `docs/ARCHITECTURE.md`

---

**All fixtures are fictional and machine-generated for testing only.**
**Generator**: `generate.py` · **Last regenerated**: 2026-07-29
