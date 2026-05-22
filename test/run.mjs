#!/usr/bin/env node
/**
 * test/run.mjs — Snapshot test runner for PADD converters
 *
 * Usage:
 *   node test/run.mjs              # run all tests
 *   node test/run.mjs --update     # regenerate all snapshots
 *   node test/run.mjs --filter toc # run only tests whose name contains "toc"
 *   node test/run.mjs --verbose    # show full diff on failures
 *
 * How it works:
 *   - test/fixtures/converter/   *.in.html → storageToMarkdown() → *.snap.md
 *   - test/fixtures/preprocess/  *.in.md   → preprocessMarkdown() → *.snap.md
 *
 * On first run (no snap files): always passes and writes snapshots.
 * On subsequent runs: compares output to stored snapshot.
 * With --update: rewrites snapshots regardless (use after intentional changes).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { storageToMarkdown } from '../lib/confluence-converter.js';
import { preprocessMarkdown } from '../lib/md-preprocess.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const UPDATE  = args.includes('--update');
const VERBOSE = args.includes('--verbose');
const FILTER  = (() => { const i = args.indexOf('--filter'); return i >= 0 ? args[i + 1] : null; })();

// ─── ANSI colours ─────────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', dim: '\x1b[2m', bold: '\x1b[1m',
};

const pass = (s) => `${C.green}✓${C.reset} ${s}`;
const fail = (s) => `${C.red}✗${C.reset} ${s}`;
const skip = (s) => `${C.yellow}○${C.reset} ${s}`;
const sect = (s) => `\n${C.bold}${C.cyan}${s}${C.reset}`;

// ─── Diff helper ──────────────────────────────────────────────────────────────

function simpleDiff(expected, got) {
  const aLines = expected.split('\n');
  const bLines = got.split('\n');
  const maxLen = Math.max(aLines.length, bLines.length);
  const lines = [];
  for (let i = 0; i < maxLen; i++) {
    const a = aLines[i];
    const b = bLines[i];
    if (a === b) {
      if (VERBOSE) lines.push(`${C.dim}   ${String(i + 1).padStart(3)}: ${a ?? ''}${C.reset}`);
    } else if (a === undefined) {
      lines.push(`${C.green}  +${String(i + 1).padStart(3)}: ${b}${C.reset}`);
    } else if (b === undefined) {
      lines.push(`${C.red}  -${String(i + 1).padStart(3)}: ${a}${C.reset}`);
    } else {
      lines.push(`${C.red}  -${String(i + 1).padStart(3)}: ${a}${C.reset}`);
      lines.push(`${C.green}  +${String(i + 1).padStart(3)}: ${b}${C.reset}`);
    }
  }
  return lines.join('\n');
}

// ─── Run a single test ────────────────────────────────────────────────────────

function runTest({ name, inputFile, snapFile, convert }) {
  if (FILTER && !name.includes(FILTER)) return { status: 'skipped' };

  const input = fs.readFileSync(inputFile, 'utf8');
  let output;
  try {
    output = convert(input);
  } catch (e) {
    return { status: 'error', message: e.message };
  }

  if (UPDATE || !fs.existsSync(snapFile)) {
    fs.writeFileSync(snapFile, output, 'utf8');
    return { status: UPDATE ? 'updated' : 'created', output };
  }

  const snap = fs.readFileSync(snapFile, 'utf8');
  if (snap === output) return { status: 'pass' };
  return { status: 'fail', expected: snap, got: output };
}

// ─── Discover and run all fixtures ───────────────────────────────────────────

function discoverSuite(dir, ext, convertFn) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith(`.in${ext}`))
    .sort()
    .map(f => ({
      name: f.replace(`.in${ext}`, ''),
      inputFile: path.join(dir, f),
      snapFile: path.join(dir, f.replace(`.in${ext}`, '.snap.md')),
      convert: convertFn,
    }));
}

async function main() {
  const suites = [
    {
      label: 'CONVERTER  (pull: Confluence HTML → Markdown)',
      tests: discoverSuite(
        path.join(__dirname, 'fixtures/converter'),
        '.html',
        (html) => storageToMarkdown(html).trim()
      ),
    },
    {
      label: 'PREPROCESS (push: Markdown → verbatim blocks)',
      tests: discoverSuite(
        path.join(__dirname, 'fixtures/preprocess'),
        '.md',
        (md) => preprocessMarkdown(md).trim()
      ),
    },
  ];

  let totalPass = 0, totalFail = 0, totalSkip = 0, totalNew = 0;

  for (const suite of suites) {
    if (suite.tests.length === 0) continue;
    console.log(sect(suite.label));

    for (const test of suite.tests) {
      const result = runTest(test);
      const label = test.name.padEnd(36);

      switch (result.status) {
        case 'pass':
          console.log(pass(label));
          totalPass++;
          break;
        case 'fail':
          console.log(fail(`${label}  ${C.red}SNAPSHOT MISMATCH${C.reset}`));
          console.log(simpleDiff(result.expected, result.got));
          if (!VERBOSE) console.log(`${C.dim}  (run with --verbose for full context lines)${C.reset}`);
          totalFail++;
          break;
        case 'created':
          console.log(skip(`${label}  ${C.yellow}NEW SNAPSHOT created${C.reset}`));
          totalNew++;
          break;
        case 'updated':
          console.log(skip(`${label}  ${C.yellow}snapshot updated${C.reset}`));
          totalNew++;
          break;
        case 'skipped':
          totalSkip++;
          break;
        case 'error':
          console.log(fail(`${label}  ${C.red}ERROR: ${result.message}${C.reset}`));
          totalFail++;
          break;
      }
    }
  }

  console.log('');
  const summary = [
    totalPass  > 0 ? `${C.green}${totalPass} passed${C.reset}` : null,
    totalFail  > 0 ? `${C.red}${totalFail} failed${C.reset}` : null,
    totalNew   > 0 ? `${C.yellow}${totalNew} new/updated${C.reset}` : null,
    totalSkip  > 0 ? `${C.dim}${totalSkip} skipped${C.reset}` : null,
  ].filter(Boolean).join('  ·  ');
  console.log(summary || 'No tests found.');

  if (totalFail > 0) {
    console.log(`\n${C.dim}To accept these changes as the new baseline: node test/run.mjs --update${C.reset}`);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
