#!/usr/bin/env python3
"""
Generates fixtures/ci-logs/*.log and fixtures/manifest.json.

Purpose: these fixtures are the test bed for the error-section extractor
(SPEC.md S6). Each fixture is deliberately built to a *different* geometry
(total lines, anchor position, ANSI density, ##[group] count) so that the
extractor's window/anchor/compression logic is exercised across the space
of real-world shapes, not just one shape repeated ten times.

Pure standard library only. Deterministic: every fixture uses
random.seed(<filename>), so re-running this script always reproduces the
exact same bytes. If you need to change a fixture, change its config below
and rerun -- do not hand-edit the .log or manifest.json files.

Usage:
    python3 generate.py
"""
import json
import os
import random
import re

ESC = chr(27)
BEL = chr(7)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "ci-logs")
MANIFEST_PATH = os.path.join(HERE, "manifest.json")

# ---------------------------------------------------------------------------
# Shared vocabulary
# ---------------------------------------------------------------------------

FAKE_PKGS = [
    "left-pad-fork", "colorz-cli", "fetch-lite", "json-safe-parse", "mini-glob",
    "retry-once", "stream-peek", "uuid-lite", "chalk-min", "semver-tiny",
    "proxy-agent-fake", "debug-lite", "yaml-min", "ini-parse-fast", "glob-walker",
    "request-legacy", "tar-stream-old", "querystring-es3", "har-validator-lite",
]

# Canonical fake-secret categories. Every value here is a well-known example
# value or an obviously fabricated one -- never a real credential.
SECRET_LINES = {
    "aws_access_key": lambda rng: "Resolved upload credentials: AKIAIOSFODNN7EXAMPLE (role: artifact-cache-writer)",
    "db_connection_string": lambda rng: "Using connection string postgres://ciuser:hunter2@db.internal.example.com:5432/appdb",
    "fs_path_runner": lambda rng: "Working directory resolved to /home/runner/work/whatsupCICD/whatsupCICD",
    "fs_path_mac": lambda rng: "Local cache mirror path: /Users/testuser/Library/Caches/pip/wheels",
    "internal_ip": lambda rng: "Connecting to internal build cache at 10.0.3.42:9000",
    "bearer_token": lambda rng: "Authorization header sent: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fake.signaturepayload",
}

FORBIDDEN_WORDS_RE = re.compile(
    r"error|failed|exception|panic|traceback|fatal|assert|✗|×|✖", re.IGNORECASE
)

# ---------------------------------------------------------------------------
# Time
# ---------------------------------------------------------------------------


class TimeCounter:
    """Monotonically increasing fake GHA timestamp, 'YYYY-MM-DDTHH:MM:SS.NNNNNNNZ'."""

    def __init__(self):
        self.y, self.mo, self.d, self.h, self.mi, self.s = 2026, 3, 14, 8, 21, 33
        self.micro = 0

    def next(self, rng):
        self.micro += rng.randint(500, 900_000)
        while self.micro >= 1_000_000:
            self.micro -= 1_000_000
            self.s += 1
            if self.s >= 60:
                self.s -= 60
                self.mi += 1
                if self.mi >= 60:
                    self.mi -= 60
                    self.h += 1
        frac = f"{self.micro:06d}0"  # 7 digits, matches GHA's odd-looking precision
        return f"{self.y:04d}-{self.mo:02d}-{self.d:02d}T{self.h:02d}:{self.mi:02d}:{self.s:02d}.{frac}Z"


# ---------------------------------------------------------------------------
# ANSI unit injection -- exact escape-character counts
# ---------------------------------------------------------------------------

_HEAVY = ["sgr_color", "sgr_bold", "clear_cursor_combo"]  # 2 ESC chars each
_LIGHT = ["clear_line", "cursor_up", "cursor_col"]  # 1 ESC char each


def make_ansi_units(target, rng, include_osc=False):
    """Return a list of (kind, cost) whose costs sum to exactly `target`."""
    units = []
    remaining = target
    if include_osc and remaining >= 1:
        # Reserve exactly one OSC unit up front so it survives regardless of
        # whether `target` is even (which would otherwise be fully consumed
        # by cost-2 heavy units before the light/osc loop ever runs).
        units.append(("osc", 1))
        remaining -= 1
    while remaining >= 2:
        units.append((rng.choice(_HEAVY), 2))
        remaining -= 2
    while remaining >= 1:
        units.append((rng.choice(_LIGHT), 1))
        remaining -= 1
    rng.shuffle(units)
    return units


def render_unit(kind, text, rng):
    if kind == "sgr_color":
        code = rng.choice(["31", "32", "33", "34", "36"])
        return f"{ESC}[{code}m{text}{ESC}[0m"
    if kind == "sgr_bold":
        return f"{ESC}[1;33m{text}{ESC}[0m"
    if kind == "clear_cursor_combo":
        return f"{ESC}[2K{ESC}[1A{text}"
    if kind == "clear_line":
        return f"{ESC}[2K{text}"
    if kind == "cursor_up":
        return f"{ESC}[1A{text}"
    if kind == "cursor_col":
        return f"{ESC}[G{text}"
    if kind == "osc":
        return f"{ESC}]0;GitHub Actions{BEL}{text}"
    return text


# ---------------------------------------------------------------------------
# Builder
# ---------------------------------------------------------------------------


class Builder:
    def __init__(self):
        self.rows = []  # list of dict(text=str, ts=bool, decorable=bool)

    def add(self, text, ts=True, decorable=False):
        self.rows.append({"text": text, "ts": ts, "decorable": decorable})
        return len(self.rows)  # 1-indexed line number just written

    def add_many(self, texts, ts=True, decorable=True):
        for t in texts:
            self.add(t, ts=ts, decorable=decorable)

    def line_count(self):
        return len(self.rows)

    def render(self, rng):
        tc = TimeCounter()
        out = []
        for row in self.rows:
            if row["ts"]:
                out.append(f"{tc.next(rng)} {row['text']}")
            else:
                out.append(row["text"])
        return out

    def apply_ansi(self, target, rng, include_osc=False):
        if target <= 0:
            return
        units = make_ansi_units(target, rng, include_osc=include_osc)
        pool = [i for i, r in enumerate(self.rows) if r["decorable"]]
        rng.shuffle(pool)
        if len(pool) < len(units):
            raise ValueError("not enough decorable lines for requested ANSI density")
        for (kind, _cost), idx in zip(units, pool):
            self.rows[idx]["text"] = render_unit(kind, self.rows[idx]["text"], rng)


def group_open(b, label):
    return b.add(f"##[group]{label}", decorable=False)


def group_close(b):
    return b.add("##[endgroup]", decorable=False)


def setup_noise(b, rng, n_lines):
    """n_lines of generic pre-error noise: checkout %, cache, npm warn, info ticks."""
    kinds = ["checkout", "checkout", "info", "cache", "npmwarn", "checkout", "info"]
    for i in range(n_lines):
        kind = kinds[i % len(kinds)]
        if kind == "checkout":
            pct = min(100, (i * 7) % 100 + 4)
            b.add(f"remote: Compressing objects... {pct}%", decorable=True)
        elif kind == "cache":
            b.add(f"Cache restored successfully ({rng.randint(50, 900)} MB, key hit)", decorable=True)
        elif kind == "npmwarn":
            pkg = rng.choice(FAKE_PKGS)
            ver = f"{rng.randint(0, 9)}.{rng.randint(0, 20)}.{rng.randint(0, 20)}"
            b.add(f"npm WARN deprecated {pkg}@{ver}: this package is no longer maintained", decorable=True)
        else:
            b.add(f"info: processing step {i + 1}/{n_lines}", decorable=True)


def tail_noise(b, rng, n_lines):
    """n_lines of post-error noise: progress bars, generic cleanup chatter."""
    for i in range(n_lines):
        pct = min(100, (i * 11) % 100 + 3)
        if i % 4 == 0:
            b.add(f"[coverage] finalizing report... {pct}%", decorable=True)
        elif i % 4 == 1:
            b.add("Post job cleanup.", decorable=True)
        elif i % 4 == 2:
            b.add(f"Removing temporary directory /home/runner/work/_temp/{rng.randint(1000, 9999)}", decorable=True)
        else:
            b.add(f"info: teardown step {i + 1}/{n_lines}", decorable=True)


def seed_secrets(b, rng, categories):
    for cat in categories:
        b.add(SECRET_LINES[cat](rng), decorable=False)


def distribute(total, buckets):
    """Split `total` into `buckets` near-equal non-negative ints."""
    if buckets <= 0:
        return []
    base = total // buckets
    rem = total % buckets
    return [base + (1 if i < rem else 0) for i in range(buckets)]


# ---------------------------------------------------------------------------
# Generic fixture assembly (all files except 12-no-signature.log)
# ---------------------------------------------------------------------------


def assemble(cfg, rng):
    """
    cfg keys: file, language, framework, error_class, total, anchor, groups,
              ansi, secrets, before_immediate, after_immediate,
              anchor_text (raw content of the anchor line, no timestamp),
              include_osc (bool), last_group_label
    Returns (lines:list[str], anchor_line:int, anchor_text_full:str)
    """
    b = Builder()
    total = cfg["total"]
    anchor = cfg["anchor"]
    groups_total = cfg["groups"]
    setup_groups = max(0, groups_total - 2)  # minus [last/error group, cleanup group]

    before_budget = anchor - 1
    after_budget = total - anchor

    # ---- BEFORE ----
    b.add("Current runner version: '2.309.0'")
    b.add(f"Runner name: 'GitHub Actions {rng.randint(1, 9)}'")
    seed_secrets(b, rng, cfg["secrets"])

    before_immediate = cfg["before_immediate"]
    # +3 per setup group: group_open + group_close + trailing blank divider line
    fixed_before = 2 + len(cfg["secrets"]) + 3 * setup_groups + 1 + len(before_immediate)
    filler_before = before_budget - fixed_before
    if filler_before < 0:
        raise ValueError(f"{cfg['file']}: before budget too small ({filler_before})")

    per_group = distribute(filler_before, setup_groups) if setup_groups else []
    setup_labels = [
        "Run actions/checkout@v4", "Run actions/setup-node@v4", "Restore cache",
        "Install dependencies", "Run actions/setup-python@v5", "Resolve toolchain",
        "Warm build cache",
    ]
    for i in range(setup_groups):
        group_open(b, setup_labels[i % len(setup_labels)])
        setup_noise(b, rng, per_group[i])
        group_close(b)
        b.add("", ts=False)

    group_open(b, cfg["last_group_label"])
    for line in before_immediate:
        b.add(line, decorable=False)

    anchor_line = b.add(cfg["anchor_text"], decorable=False)
    assert anchor_line == anchor, f"{cfg['file']}: anchor mismatch {anchor_line} != {anchor}"

    # ---- AFTER ----
    after_immediate = cfg["after_immediate"]
    # +endgroup +blank divider +cleanup(open+content+close) +final line
    fixed_after = len(after_immediate) + 1 + 1 + 3 + 1
    filler_after = after_budget - fixed_after
    if filler_after < 0:
        raise ValueError(f"{cfg['file']}: after budget too small ({filler_after})")

    for line in after_immediate:
        b.add(line, decorable=False)
    group_close(b)
    b.add("", ts=False)

    group_open(b, "Cleanup")
    b.add("Cleanup completed successfully.", decorable=True)
    group_close(b)

    tail_noise(b, rng, filler_after)

    b.add("##[error]Process completed with exit code 1", decorable=False)

    assert b.line_count() == total, f"{cfg['file']}: total mismatch {b.line_count()} != {total}"

    b.apply_ansi(cfg["ansi"], rng, include_osc=cfg.get("include_osc", False))
    rendered = b.render(rng)
    anchor_text_full = rendered[anchor_line - 1]
    return rendered, anchor_line, anchor_text_full


# ---------------------------------------------------------------------------
# 09: ESLint cascade (>=180 same-shape "error ... no-xxx" lines)
# ---------------------------------------------------------------------------

ESLINT_RULES = [
    ("'apiKey' is defined but never used", "no-unused-vars"),
    ("'result' is assigned a value but never used", "no-unused-vars"),
    ("Unexpected console statement", "no-console"),
    ("'req' is defined but never used", "no-unused-vars"),
    ("Unexpected var, use let or const instead", "no-var"),
    ("Unnecessary escape character", "no-useless-escape"),
    ("'value' is not defined", "no-undef"),
    ("Empty block statement", "no-empty"),
]  # every rule here is deliberately "no-*" so gen_cascade_block's output
   # matches the extractor's cascade regex on 100% of generated lines


def gen_cascade_block(rng, count):
    lines = []
    for i in range(count):
        msg, rule = ESLINT_RULES[i % len(ESLINT_RULES)]
        row = 12 + (i % 40)
        col = 3 + (i % 20)
        lines.append(f"  {row}:{col}  error  {msg}  {rule}")
    return lines


# ---------------------------------------------------------------------------
# 06: Java stack trace with >=40 lines, folded third-party frames (>=3 in a row)
# ---------------------------------------------------------------------------


def gen_java_stack(rng, min_lines=42):
    first_party = [
        "com.acme.service.UserService.validate(UserService.java:88)",
        "com.acme.service.UserService.create(UserService.java:45)",
        "com.acme.web.UserController.createUser(UserController.java:61)",
        "com.acme.web.UserController.handleRequest(UserController.java:33)",
    ]
    third_party = [
        "org.springframework.aop.framework.ReflectiveMethodInvocation.proceed(ReflectiveMethodInvocation.java:186)",
        "org.springframework.aop.framework.CglibAopProxy$CglibMethodInvocation.proceed(CglibAopProxy.java:750)",
        "org.springframework.transaction.interceptor.TransactionInterceptor.invoke(TransactionInterceptor.java:123)",
        "org.springframework.aop.framework.JdkDynamicAopProxy.invoke(JdkDynamicAopProxy.java:223)",
        "java.base/jdk.internal.reflect.NativeMethodAccessorImpl.invoke0(Native Method)",
        "java.base/jdk.internal.reflect.NativeMethodAccessorImpl.invoke(NativeMethodAccessorImpl.java:77)",
        "java.base/jdk.internal.reflect.DelegatingMethodAccessorImpl.invoke(DelegatingMethodAccessorImpl.java:43)",
        "java.base/java.lang.reflect.Method.invoke(Method.java:568)",
        "org.springframework.web.method.support.InvocableHandlerMethod.doInvoke(InvocableHandlerMethod.java:205)",
    ]
    lines = [
        'java.lang.NullPointerException: Cannot invoke "String.length()" because "name" is null',
        "\tat " + first_party[0],
        "\tat " + first_party[1],
    ]
    idx = 0
    while len(lines) < min_lines - 4:
        for fr in third_party:
            lines.append("\tat " + fr)
            idx += 1
            if len(lines) >= min_lines - 4:
                break
    lines.append("\tat " + first_party[2])
    lines.append("\tat " + first_party[3])
    lines.append("Caused by: java.lang.IllegalStateException: user context not initialized")
    lines.append("\t... 6 more")
    return lines


# ---------------------------------------------------------------------------
# 11: oversized webpack bundle -- huge lines + deep node_modules stack
# ---------------------------------------------------------------------------


def gen_long_minified_line(rng, idx):
    charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$"
    body = "".join(rng.choice(charset) for _ in range(2200))
    return f"/* webpack chunk {idx} */!function(e){{var t={{}};function n(r){{if(t[r])return t[r].exports;{body}}}}}"


def gen_base64_blob_line(rng, idx):
    charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    body = "".join(rng.choice(charset) for _ in range(2400))
    return f"data:application/font-woff2;base64,{body}=="


def gen_node_modules_frames(rng, count):
    pkgs = [
        "webpack", "loader-runner", "enhanced-resolve", "watchpack", "terser-webpack-plugin",
        "schema-utils", "tapable", "webpack-sources", "acorn", "browserslist",
    ]
    frames = []
    for i in range(count):
        pkg = pkgs[i % len(pkgs)]
        frames.append(
            f"    at Object.<anonymous> (/home/runner/work/whatsupCICD/whatsupCICD/node_modules/{pkg}/lib/index.js:{10 + i}:{5 + (i % 30)})"
        )
    return frames


# ---------------------------------------------------------------------------
# 12: no-signature failure (silent exit 1, zero Tier A/B/C hits)
# ---------------------------------------------------------------------------


def build_no_signature(cfg, rng):
    b = Builder()
    total = cfg["total"]
    groups_total = cfg["groups"]
    setup_groups = max(0, groups_total - 2)

    b.add("Current runner version: '2.309.0'")
    b.add(f"Runner name: 'GitHub Actions {rng.randint(1, 9)}'")
    seed_secrets(b, rng, cfg["secrets"])

    # +last group(open+content+close) +cleanup(open+content+close) +final line
    fixed = 2 + len(cfg["secrets"]) + 3 * setup_groups + 3 + 3 + 1
    filler = total - fixed
    if filler < 0:
        raise ValueError("12-no-signature.log: budget too small")

    per_group = distribute(filler, setup_groups + 1)  # spread across setup groups + last group

    setup_labels = ["Run actions/checkout@v4", "Run actions/setup-node@v4", "Restore cache"]
    for i in range(setup_groups):
        group_open(b, setup_labels[i % len(setup_labels)])
        setup_noise(b, rng, per_group[i])
        group_close(b)
        b.add("", ts=False)

    group_open(b, "Run build script")
    setup_noise(b, rng, per_group[-1])
    b.add("Script finished. No further output was produced.", decorable=False)
    group_close(b)

    group_open(b, "Cleanup")
    b.add("Cleanup completed successfully.", decorable=True)
    group_close(b)

    b.add("##[error]Process completed with exit code 1", decorable=False)

    assert b.line_count() == total, f"12: total mismatch {b.line_count()} != {total}"
    b.apply_ansi(cfg["ansi"], rng, include_osc=False)
    rendered = b.render(rng)

    # Self-check: no Tier A/B/C trigger words anywhere except the final line.
    for i, line in enumerate(rendered[:-1]):
        if FORBIDDEN_WORDS_RE.search(line):
            raise ValueError(f"12-no-signature.log leaked a signature word on line {i + 1}: {line!r}")

    return rendered


# ---------------------------------------------------------------------------
# Fixture configs
# ---------------------------------------------------------------------------


def build_fixture_configs(rng_master):
    cfgs = []

    cfgs.append(dict(
        file="01-typescript-tsc.log", language="typescript", framework="tsc",
        error_class="E_COMPILE", total=320, anchor=240, groups=5, ansi=22,
        secrets=["fs_path_runner", "bearer_token"],
        last_group_label="Run build/test",
        before_immediate=["> tsc -p tsconfig.json --noEmit"],
        anchor_text="src/api/handlers/profile.ts(45,18): error TS2339: Property 'map' does not exist on type 'never'.",
        after_immediate=[
            "src/api/handlers/profile.ts(46,5): error TS2322: Type 'string' is not assignable to type 'number'.",
            "src/api/handlers/profile.ts(52,10): error TS2551: Property 'mapp' does not exist on type 'UserList'. Did you mean 'map'?",
            "",
            "Found 3 errors in 1 file.",
            "",
            "Errors  Files",
            "     3  src/api/handlers/profile.ts:45",
        ],
        notes="標準情況。錨點後有 80 行可取，前有 30 行可取。",
    ))

    cfgs.append(dict(
        file="02-jest-test-failure.log", language="javascript", framework="jest",
        error_class="E_TEST", total=190, anchor=168, groups=4, ansi=35,
        secrets=["internal_ip", "fs_path_mac"],
        last_group_label="Run test",
        before_immediate=["> jest --ci --runInBand"],
        anchor_text="  ● UserProfile component › renders avatar › updates src when prop changes",
        after_immediate=[
            "    expect(received).toEqual(expected) // deep equality",
            "",
            "    Expected: \"https://cdn.example.com/avatars/new.png\"",
            "    Received: \"https://cdn.example.com/avatars/old.png\"",
            "",
            "      42 |   expect(img.src).toEqual(newSrc);",
            "Tests:       1 failed, 27 passed, 28 total",
        ],
        notes="錨點靠尾端：後方只剩 22 行，視窗必須能處理「後 80 行不夠」。",
    ))

    cfgs.append(dict(
        file="03-python-pytest.log", language="python", framework="pytest",
        error_class="E_TEST", total=260, anchor=38, groups=6, ansi=48,
        secrets=["db_connection_string", "fs_path_runner"],
        last_group_label="Run pytest",
        before_immediate=[
            "> pytest -q tests/",
            "tests/test_auth.py:88: in test_token_refresh",
            "    token = session.encode()",
        ],
        anchor_text="E   AttributeError: 'NoneType' object has no attribute 'encode'",
        after_immediate=[
            "",
            "=================================== short test summary info ===================================",
            "FAILED tests/test_auth.py::test_token_refresh - AttributeError: 'NoneType' object has no attribute 'encode'",
            "1 failed, 42 passed in 3.21s",
        ],
        notes="錨點靠開頭：前方只有 37 行，視窗必須能處理「前 30 行不夠」。",
    ))

    cfgs.append(dict(
        file="04-go-build-test.log", language="go", framework="go test",
        error_class="E_COMPILE", total=210, anchor=145, groups=7, ansi=61,
        secrets=["aws_access_key", "internal_ip"],
        last_group_label="Run go build",
        before_immediate=["> go build ./..."],
        anchor_text="cmd/server/main.go:34:12: undefined: config.LoadEnv",
        after_immediate=[
            "cmd/server/main.go:35:9: undefined: config.LoadEnv",
            "FAIL\tgithub.com/acme/server/cmd/server [build failed]",
        ],
        notes="標準情況，但錯誤前後緊鄰 group 邊界。",
    ))

    cfgs.append(dict(
        file="05-rust-cargo.log", language="rust", framework="cargo",
        error_class="E_COMPILE", total=480, anchor=300, groups=8, ansi=74, include_osc=True,
        secrets=["aws_access_key", "db_connection_string"],
        last_group_label="Run cargo build",
        before_immediate=["> cargo build --release"],
        anchor_text="error[E0308]: mismatched types",
        after_immediate=[
            "  --> src/handlers/mod.rs:88:24",
            "   |",
            "88 |     let result: u32 = compute_value();",
            "   |                       ^^^^^^^^^^^^^^^ expected `u32`, found `i64`",
            "   |",
            "   = note: expected type `u32`",
            "              found type `i64`",
            "",
            "error: aborting due to previous error",
            "",
            "For more information about this error, try `rustc --explain E0308`.",
            "error: could not compile `acme-server` (bin \"acme-server\") due to previous error",
        ],
        notes="長檔。錨點前後都遠超過 30/80。含 OSC escape。",
    ))

    java_stack = gen_java_stack(rng_master)
    cfgs.append(dict(
        file="06-java-maven.log", language="java", framework="maven",
        error_class="E_COMPILE", total=240, anchor=150, groups=5, ansi=87,
        secrets=["fs_path_runner", "fs_path_mac"],
        last_group_label="Run mvn test",
        before_immediate=["> mvn -B test"],
        anchor_text="[ERROR] COMPILATION ERROR :",
        after_immediate=["[ERROR] Failed to execute goal on project acme-server"] + java_stack,
        notes="Java stack trace ≥40 行，測第三方 frame 折疊（§6.4 C4）。",
    ))

    cfgs.append(dict(
        file="07-npm-dependency.log", language="javascript", framework="npm",
        error_class="E_DEPENDENCY", total=175, anchor=120, groups=3, ansi=100,
        secrets=["bearer_token", "internal_ip"],
        last_group_label="Run npm ci",
        before_immediate=["> npm ci"],
        anchor_text="npm ERR! ERESOLVE unable to resolve dependency tree",
        after_immediate=[
            "npm ERR!",
            "npm ERR! While resolving: acme-web@2.4.1",
            "npm ERR! Found: react@18.2.0",
            "npm ERR! node_modules/react",
            "npm ERR!   react@\"^18.2.0\" from the root project",
            "npm ERR!",
            "npm ERR! Could not resolve dependency:",
            "npm ERR! peer react@\"^17.0.0\" from some-old-lib@3.1.0",
            "npm ERR!",
            "npm ERR! A complete log of this run can be found in: /home/runner/.npm/_logs/2026-03-14T08_21_37_123Z-debug-0.log",
        ],
        notes="標準情況。",
    ))

    cfgs.append(dict(
        file="08-docker-build.log", language="dockerfile", framework="docker buildkit",
        error_class="E_NETWORK", total=230, anchor=160, groups=6, ansi=113,
        secrets=["aws_access_key", "fs_path_runner"],
        last_group_label="Run docker build",
        before_immediate=["> docker buildx build --push -t registry.example.com/acme/app:latest ."],
        anchor_text="#7 ERROR: failed to solve: failed to fetch AWS credential",
        after_immediate=[
            "#7 0.842 error: failed to refresh cached credentials, request canceled, context deadline exceeded",
            "------",
            " > importing cache manifest from registry.example.com/acme/app:buildcache:",
            "------",
            "ERROR: failed to solve: failed to fetch AWS credential: context deadline exceeded",
        ],
        notes="標準情況。",
    ))

    cascade = gen_cascade_block(rng_master, 190)
    cfgs.append(dict(
        file="09-eslint-lint.log", language="javascript", framework="eslint",
        error_class="E_LINT", total=900, anchor=700, groups=9, ansi=120,
        secrets=["db_connection_string", "bearer_token"],
        last_group_label="Run eslint",
        before_immediate=["> eslint . --ext .js,.ts", "", "src/api/handlers/profile.js"],
        anchor_text=cascade[0],
        after_immediate=cascade[1:] + [
            "",
            "✖ 190 problems (190 errors, 0 warnings)",
        ],
        notes="cascade 測試：≥180 條同型錯誤，第一筆（非最後一筆）為錨點。",
    ))

    cfgs.append(dict(
        file="10-infra-timeout.log", language="shell", framework="docker orchestration",
        error_class="E_TIMEOUT", total=200, anchor=130, groups=4, ansi=19,
        secrets=["internal_ip", "aws_access_key"],
        last_group_label="Run integration tests",
        before_immediate=["> ./scripts/wait-for-it.sh db.internal.example.com:5432 -- ./run-integration.sh"],
        anchor_text="Error: connect ETIMEDOUT 10.0.3.42:5432",
        after_immediate=[
            "The runner hit timeout while waiting for integration test environment setup",
            "##[error]The operation was canceled.",
            "This step has timed out after 15 minutes.",
        ],
        notes="E_INFRA/E_TIMEOUT，非人為失敗。",
    ))

    cfgs.append(dict(
        file="12-no-signature.log", language="shell", framework="unknown",
        error_class="E_UNKNOWN", total=150, groups=3, ansi=15,
        secrets=["fs_path_runner", "internal_ip"],
        notes="失敗退路測試：無可辨識錯誤簽章，job 靜默 exit 1。",
        no_signature=True,
    ))

    return cfgs


def build_oversized_config():
    return dict(
        file="11-oversized-webpack.log", language="javascript", framework="webpack",
        error_class="E_COMPILE", total=2600, anchor=1900, groups=8, ansi=65,
        secrets=["fs_path_mac", "db_connection_string", "bearer_token"],
        last_group_label="Run webpack build",
        notes="壓縮階梯測試：30/80 視窗單獨即超過 4k tokens，且視窗內 ≥30 層 node_modules stack frame。",
    )


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    rng_master = random.Random("whatsupCICD-fixtures-master-seed")

    fixtures_manifest = []

    for cfg in build_fixture_configs(rng_master):
        rng = random.Random(cfg["file"])

        if cfg.get("no_signature"):
            lines = build_no_signature(cfg, rng)
            anchor_line = None
            anchor_text_full = None
        else:
            lines, anchor_line, anchor_text_full = assemble(cfg, rng)

        path = os.path.join(OUT_DIR, cfg["file"])
        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")

        entry = {
            "file": cfg["file"],
            "language": cfg["language"],
            "framework": cfg["framework"],
            "expected_error_class": cfg["error_class"],
            "anchor_line": anchor_line,
            "anchor_text": anchor_text_full,
            "total_lines": len(lines),
            "notes": cfg["notes"],
            "seeded_secrets": cfg["secrets"],
        }
        if cfg.get("no_signature"):
            entry["expected_signature_found"] = False
        fixtures_manifest.append(entry)

    # ---- file 11: oversized webpack, built separately (huge, custom content) ----
    cfg11 = build_oversized_config()
    rng11 = random.Random(cfg11["file"])
    lines11, anchor11, anchor_text11 = build_oversized(cfg11, rng11)
    path11 = os.path.join(OUT_DIR, cfg11["file"])
    with open(path11, "w", encoding="utf-8") as f:
        f.write("\n".join(lines11) + "\n")
    fixtures_manifest.insert(10, {
        "file": cfg11["file"],
        "language": cfg11["language"],
        "framework": cfg11["framework"],
        "expected_error_class": cfg11["error_class"],
        "anchor_line": anchor11,
        "anchor_text": anchor_text11,
        "total_lines": len(lines11),
        "notes": cfg11["notes"],
        "seeded_secrets": cfg11["secrets"],
    })

    # keep manifest ordered 01..12 by filename
    fixtures_manifest.sort(key=lambda e: e["file"])

    with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
        json.dump({"fixtures": fixtures_manifest}, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"Wrote {len(fixtures_manifest)} fixtures to {OUT_DIR}")
    print(f"Wrote manifest to {MANIFEST_PATH}")


def build_oversized(cfg, rng):
    b = Builder()
    total = cfg["total"]
    anchor = cfg["anchor"]
    groups_total = cfg["groups"]
    setup_groups = max(0, groups_total - 2)

    before_budget = anchor - 1
    after_budget = total - anchor

    b.add("Current runner version: '2.309.0'")
    b.add(f"Runner name: 'GitHub Actions {rng.randint(1, 9)}'")
    seed_secrets(b, rng, cfg["secrets"])

    before_immediate = ["> webpack --mode production --config webpack.config.js"]
    fixed_before = 2 + len(cfg["secrets"]) + 3 * setup_groups + 1 + len(before_immediate)
    filler_before = before_budget - fixed_before
    if filler_before < 0:
        raise ValueError("11-oversized-webpack.log: before budget too small")

    # Reserve the last ~40 lines of the before-budget for dense window content
    # (long minified lines + node_modules frames) so the 30/80 window around
    # the anchor is guaranteed to blow past the token budget.
    dense_before_n = min(40, filler_before)
    generic_before_n = filler_before - dense_before_n

    per_group = distribute(generic_before_n, setup_groups) if setup_groups else []
    setup_labels = ["Run actions/checkout@v4", "Run actions/setup-node@v4", "Restore cache",
                    "Install dependencies", "Warm webpack cache", "Resolve toolchain"]
    for i in range(setup_groups):
        group_open(b, setup_labels[i % len(setup_labels)])
        setup_noise(b, rng, per_group[i])
        group_close(b)
        b.add("", ts=False)

    group_open(b, cfg["last_group_label"])
    for line in before_immediate:
        b.add(line, decorable=False)

    # dense pre-anchor content: long minified lines + node_modules frames
    frames_before = gen_node_modules_frames(rng, dense_before_n // 2)
    long_before = [gen_long_minified_line(rng, i) for i in range(dense_before_n - len(frames_before))]
    dense_before = []
    fi, li = 0, 0
    while len(dense_before) < dense_before_n:
        if fi < len(frames_before):
            dense_before.append(frames_before[fi]); fi += 1
        if li < len(long_before) and len(dense_before) < dense_before_n:
            dense_before.append(long_before[li]); li += 1
    for line in dense_before:
        b.add(line, decorable=False)

    anchor_line = b.add(
        "ERROR in ./src/index.js Module build failed: Error: Unexpected token in minified bundle",
        decorable=False,
    )
    assert anchor_line == anchor, f"11: anchor mismatch {anchor_line} != {anchor}"

    # dense post-anchor content
    dense_after_n = min(60, after_budget - 20)
    frames_after = gen_node_modules_frames(rng, max(0, (dense_after_n - 10) // 2))
    long_after = [gen_long_minified_line(rng, 1000 + i) for i in range(5)]
    base64_after = [gen_base64_blob_line(rng, i) for i in range(3)]
    dense_after = ["    at Module._compile (node:internal/modules/cjs/loader:1254:14)"] + frames_after + long_after + base64_after
    dense_after = dense_after[:dense_after_n]

    after_immediate = dense_after + [
        "",
        "webpack 5.91.0 compiled with 1 error in 48213 ms",
    ]
    fixed_after = len(after_immediate) + 1 + 1 + 3 + 1
    filler_after = after_budget - fixed_after
    if filler_after < 0:
        raise ValueError("11-oversized-webpack.log: after budget too small")

    for line in after_immediate:
        b.add(line, decorable=False)
    group_close(b)
    b.add("", ts=False)

    group_open(b, "Cleanup")
    b.add("Cleanup completed successfully.", decorable=True)
    group_close(b)

    tail_noise(b, rng, filler_after)

    b.add("##[error]Process completed with exit code 1", decorable=False)

    assert b.line_count() == total, f"11: total mismatch {b.line_count()} != {total}"
    b.apply_ansi(cfg["ansi"], rng, include_osc=False)
    rendered = b.render(rng)
    anchor_text_full = rendered[anchor_line - 1]
    return rendered, anchor_line, anchor_text_full


if __name__ == "__main__":
    main()
