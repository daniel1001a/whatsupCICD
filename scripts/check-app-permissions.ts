#!/usr/bin/env tsx
/**
 * check-app-permissions.ts — R6 最小權限守門員
 *
 * 讀取 app-manifest.yml 的 default_permissions，比對是否「恰好等於」
 * 允許集合 ALLOWED_PERMISSIONS。多一項、少一項、或層級被拉高成 write，
 * 一律視為違反 R6，退出碼 1。
 *
 * 背景見 SPEC.md §5「GitHub App 權限」。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

// 允許集合（唯一真實來源見 SPEC.md §5）。
// 改這個常數本身就是一次需要產品負責人批准的變更。
const ALLOWED_PERMISSIONS: Readonly<Record<string, string>> = Object.freeze({
  actions: 'read',
  metadata: 'read',
});

const MANIFEST_PATH = resolve(process.cwd(), 'app-manifest.yml');

interface AppManifest {
  readonly default_permissions?: unknown;
}

function fail(message: string): never {
  console.error(`\x1b[31m✗ R6 最小權限檢查失敗\x1b[0m`);
  console.error(message);
  console.error(
    '\nR6 最小權限：新增或提升權限需產品負責人批准，見 SPEC.md §5「GitHub App 權限」。',
  );
  process.exit(1);
}

function main(): void {
  let raw: string;
  try {
    raw = readFileSync(MANIFEST_PATH, 'utf8');
  } catch (err) {
    fail(`讀不到 ${MANIFEST_PATH}：${err instanceof Error ? err.message : String(err)}`);
  }

  let manifest: AppManifest;
  try {
    manifest = parse(raw) as AppManifest;
  } catch (err) {
    fail(`app-manifest.yml 不是合法 YAML：${err instanceof Error ? err.message : String(err)}`);
  }

  const rawPermissions: unknown = manifest.default_permissions;
  if (
    rawPermissions === undefined ||
    rawPermissions === null ||
    typeof rawPermissions !== 'object' ||
    Array.isArray(rawPermissions)
  ) {
    fail('app-manifest.yml 缺少 default_permissions 區塊。');
  }
  const actual = rawPermissions as Record<string, unknown>;

  const actualKeys = Object.keys(actual);
  const allowedKeys = Object.keys(ALLOWED_PERMISSIONS);

  const extra = actualKeys.filter((k) => !allowedKeys.includes(k));
  const missing = allowedKeys.filter((k) => !actualKeys.includes(k));
  const escalated: string[] = [];
  const wrongLevel: string[] = [];

  for (const key of actualKeys) {
    if (!allowedKeys.includes(key)) continue; // 已在 extra 裡報過
    const expectedLevel = ALLOWED_PERMISSIONS[key];
    const actualLevel = actual[key];
    if (actualLevel !== expectedLevel) {
      if (actualLevel === 'write' || actualLevel === 'admin') {
        escalated.push(`${key}: ${actualLevel}（預期 ${expectedLevel}）`);
      } else {
        wrongLevel.push(`${key}: ${String(actualLevel)}（預期 ${expectedLevel}）`);
      }
    }
  }

  const problems: string[] = [];
  if (extra.length > 0) {
    problems.push(`多出未申請的權限：${extra.map((k) => `${k}: ${String(actual[k])}`).join(', ')}`);
  }
  if (missing.length > 0) {
    problems.push(`缺少必要權限：${missing.join(', ')}`);
  }
  if (escalated.length > 0) {
    problems.push(`權限被拉高至 write/admin：${escalated.join(', ')}`);
  }
  if (wrongLevel.length > 0) {
    problems.push(`權限層級不符：${wrongLevel.join(', ')}`);
  }

  if (problems.length > 0) {
    fail(problems.map((p) => `- ${p}`).join('\n'));
  }

  console.log(
    '\x1b[32m✓ R6 通過：GitHub App 權限恰好等於 { actions: read, metadata: read }\x1b[0m',
  );
}

main();
