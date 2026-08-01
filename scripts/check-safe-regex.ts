#!/usr/bin/env tsx
/**
 * check-safe-regex.ts — ReDoS 守門員
 *
 * 掃描 src/**\/*.ts，用 TypeScript compiler API 的 AST 找出所有
 * RegularExpressionLiteral（不用 regex 找 regex，避免誤判字串裡的斜線），
 * 對每一條跑 safe-regex 套件，抓出有災難性回溯風險的 pattern。
 *
 * 豁免：在 regex 字面量的「前一行」寫
 *   // safe-regex-disable: <理由>
 * 理由文字不可空白，否則視為未豁免。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import ts from 'typescript';

// safe-regex 沒有內附型別，也沒有 @types/safe-regex 可裝（禁止安裝新套件）。
// 用 createRequire 載入，避開對未型別模組的 import 型別檢查，不新增檔案。
const require = createRequire(import.meta.url);
const safe = require('safe-regex') as (pattern: string) => boolean;

const SRC_ROOT = join(process.cwd(), 'src');
const DISABLE_COMMENT_RE = /^\/\/\s*safe-regex-disable:\s*(\S.*)$/;

interface RegexHit {
  readonly file: string;
  readonly line: number; // 1-based
  readonly text: string;
  readonly exempted: boolean;
}

function walk(dir: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(full));
    } else if (entry.isFile() && full.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

function findRegexLiterals(filePath: string, sourceText: string): RegexHit[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  const lines = sourceText.split(/\r?\n/);
  const hits: RegexHit[] = [];

  function visit(node: ts.Node): void {
    if (ts.isRegularExpressionLiteral(node)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const lineNumber = line + 1; // 1-based
      const prevLine = line > 0 ? (lines[line - 1] ?? '') : '';
      const match = DISABLE_COMMENT_RE.exec(prevLine.trim());
      const exempted = match !== null && match[1] !== undefined && match[1].trim().length > 0;
      hits.push({
        file: filePath,
        line: lineNumber,
        text: node.getText(sourceFile),
        exempted,
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return hits;
}

function extractPatternAndFlags(literalText: string): { pattern: string; flags: string } | null {
  // literalText 形如 /foo\/bar/gi，最後一個未跳脫的 '/' 之後是 flags
  if (!literalText.startsWith('/')) return null;
  let i = literalText.length - 1;
  while (i > 0) {
    if (literalText[i] === '/') {
      // 確認不是被跳脫的斜線（往前數連續反斜線數量須為偶數才代表沒被跳脫）
      let backslashes = 0;
      let j = i - 1;
      while (j > 0 && literalText[j] === '\\') {
        backslashes++;
        j--;
      }
      if (backslashes % 2 === 0) break;
    }
    i--;
  }
  if (i <= 0) return null;
  const pattern = literalText.slice(1, i);
  const flags = literalText.slice(i + 1);
  return { pattern, flags };
}

function main(): void {
  const files = walk(SRC_ROOT).sort();

  let totalRegex = 0;
  let unsafeCount = 0;
  let exemptedCount = 0;
  const unsafeHits: RegexHit[] = [];

  for (const file of files) {
    if (!statSync(file).isFile()) continue;
    const text = readFileSync(file, 'utf8');
    const hits = findRegexLiterals(file, text);
    for (const hit of hits) {
      totalRegex++;
      if (hit.exempted) {
        exemptedCount++;
        continue;
      }
      const parsed = extractPatternAndFlags(hit.text);
      if (parsed === null) {
        // 解析不出 pattern/flags，保守起見當作需要人工確認的不安全案例
        unsafeCount++;
        unsafeHits.push(hit);
        continue;
      }
      let isSafe: boolean;
      try {
        isSafe = safe(parsed.pattern);
      } catch {
        isSafe = false;
      }
      if (!isSafe) {
        unsafeCount++;
        unsafeHits.push(hit);
      }
    }
  }

  console.log(
    `掃描了 ${String(files.length)} 個檔案，找到 ${String(totalRegex)} 條 regex 字面量` +
      (exemptedCount > 0 ? `（其中 ${String(exemptedCount)} 條已豁免）` : '') +
      '。',
  );

  if (unsafeCount > 0) {
    console.error('\x1b[31m✗ ReDoS 守門員檢查失敗\x1b[0m');
    for (const hit of unsafeHits) {
      console.error(`  ${relative(process.cwd(), hit.file)}:${String(hit.line)}  ${hit.text}`);
    }
    console.error(
      `\n共 ${String(unsafeCount)} 條 regex 有災難性回溯風險。請改寫，或在前一行加註` +
        ' // safe-regex-disable: <理由> 並附上人工審查過的理由。',
    );
    process.exit(1);
  }

  console.log('\x1b[32m✓ ReDoS 守門員通過：沒有偵測到不安全的 regex\x1b[0m');
}

main();
