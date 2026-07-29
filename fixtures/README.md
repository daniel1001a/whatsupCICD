# CI Log Fixtures

This directory contains hand-crafted, **realistic but fictional** GitHub Actions failure logs for testing the Build Failure Prosecutor's error extraction and sanitization pipeline.

## Why Hand-Crafted?

We do not use real customer logs for two critical reasons:

1. **Safety**: Real logs inevitably contain actual secrets (API keys, database credentials, customer emails, internal IPs) that would expose the organization.
2. **Reproducibility**: Real logs are chaotic and change. Fixtures must be stable, version-controlled ground truth for deterministic testing.

## What They Contain

All fixtures include:

- **GitHub Actions metadata**: ISO-8601 timestamp prefixes (`2026-03-14T08:21:33.4821994Z`), `##[group]`/`##[endgroup]` markers, `##[error]` lines
- **ANSI escape sequences**: Color codes (`\x1b[31m`, `\x1b[0m`) for realism
- **Realistic noise**: npm warnings, cache messages, docker pull logs, `Post job cleanup`, etc.
- **Actual error sections**: Located mid-to-late in the file, not at the end
- **Anti-anchor**: `##[error]Process completed with exit code <N>` at the very end (the extractor must NOT select this as the primary error)
- **Seeded fake secrets**: 2+ fake credential types per file for sanitizer testing

### Seeded Fake Secrets

All secrets in fixtures are **deliberately fake** and marked as examples:

- AWS: `AKIAIOSFODNN7EXAMPLE` (official AWS example key)
- Postgres: `postgres://ciuser:hunter2@db.internal.example.com:5432/testdb` (test credentials)
- Paths: `/home/runner/work/...`, `/Users/testuser/...`
- Tokens: `Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.fake_signature_do_not_use`
- Internal IPs: `10.0.3.42`, `192.168.x.x`
- ARNs: `arn:aws:iam::EXAMPLE:user/...`

**None of these are real or functional.** They are solely for testing the sanitizer's ability to recognize patterns.

## Fixture Overview

| File | Language | Framework | Error Class | Lines | Anchor Line | Primary Error |
|------|----------|-----------|------------|-------|------------|---------------|
| 01-typescript-tsc.log | TypeScript | tsc | E_COMPILE | 48 | 27 | `error TS2339: Property 'map' does not exist` |
| 02-jest-test-failure.log | JavaScript | Jest | E_TEST | 49 | 11 | `Expected value to equal:` assertion mismatch |
| 03-python-pytest.log | Python | pytest | E_TEST | 40 | 18 | `AttributeError: 'NoneType' object has no attribute 'encode'` |
| 04-go-build-test.log | Go | go test | E_COMPILE | 41 | 8 | `undefined: config.LoadEnv` |
| 05-rust-cargo.log | Rust | cargo | E_COMPILE | 44 | 8 | `error[E0308]: mismatched types` |
| 06-java-maven.log | Java | Maven | E_COMPILE | 45 | 10 | `[ERROR] COMPILATION ERROR` |
| 07-npm-dependency.log | JavaScript | npm | E_DEPENDENCY | 46 | 11 | `npm ERR! ERESOLVE unable to resolve dependency tree` |
| 08-docker-build.log | Dockerfile | Docker/BuildKit | E_INFRA | 53 | 47 | `ERROR: failed to solve: failed to fetch AWS credential` |
| 09-eslint-lint.log | JavaScript | ESLint | E_LINT | 73 | 62 | `error: Unexpected console statement` |
| 10-infra-timeout.log | Shell | Docker Orchestration | E_TIMEOUT | 53 | 44 | `The runner hit timeout while waiting for integration test environment setup` |

## Ground Truth File: `manifest.json`

Each fixture is annotated in `manifest.json` with:

- `anchor_line`: 1-indexed line number of the primary error (verified by actual file inspection)
- `anchor_text`: Exact text at that line (for validation)
- `total_lines`: Line count (verified by `wc -l`)
- `expected_error_class`: One of `E_COMPILE`, `E_TEST`, `E_DEPENDENCY`, `E_LINT`, `E_TIMEOUT`, `E_OOM`, `E_NETWORK`, `E_AUTH`, `E_INFRA`, `E_DEPLOY`, `E_UNKNOWN`
- `seeded_secrets`: Array of fake credential types intentionally placed for sanitizer testing

**These values are verified by actual line inspection** and must be updated if files are modified.

## How to Add a New Fixture

1. **Create a new log file** in `ci-logs/` with realistic structure:
   - 150–400 lines
   - Timestamps on every line
   - GitHub Actions markers
   - ANSI codes
   - Noise + actual error mid-to-late in file
   - Process exit line at the end

2. **Determine the anchor line** by counting actual lines:
   ```bash
   wc -l ci-logs/XX-name.log
   sed -n '<anchor_line>p' ci-logs/XX-name.log
   ```

3. **Add an entry to `manifest.json`**:
   - `anchor_line` must match actual line count
   - `total_lines` verified by `wc -l`
   - All fields required

4. **Update this README** with a row in the fixture overview table.

## Verification Checklist

Before committing fixture changes:

```bash
# Validate JSON
python3 -c "import json; d=json.load(open('manifest.json')); print(f'✓ {len(d[\"fixtures\"])} fixtures loaded')"

# Verify line counts for each fixture
for f in manifest.json; do
  python3 -c "
import json
data = json.load(open('$f'))
for fix in data['fixtures']:
  file = 'ci-logs/' + fix['file']
  with open(file) as fh:
    actual_lines = len(fh.readlines())
  if actual_lines != fix['total_lines']:
    print(f'MISMATCH: {file} has {actual_lines} lines, manifest says {fix[\"total_lines\"]}')
  else:
    print(f'✓ {fix[\"file\"]}: {actual_lines} lines')
"
done

# Spot-check anchor lines
sed -n '27p' ci-logs/01-typescript-tsc.log  # Should match anchor_text
```

## Used By

- **Phase 2 testing**: Error extraction validation (do we find the right line in 8+ different languages?)
- **Phase 2 testing**: Sanitizer testing (do we mask all seeded secrets correctly?)
- **Phase 4 testing**: Rate-limit + fallback scenarios
- **Documentation**: Architecture examples in `docs/ARCHITECTURE.md`

---

**All fixtures are fictional and hand-crafted for testing only.**
**Last updated**: 2026-03-14
