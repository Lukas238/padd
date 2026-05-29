#!/usr/bin/env node

/**
 * padd confluence - Confluence sync commands
 *
 * Commands:
 *   padd confluence init [space] [folder]  → creates .confluence.yaml
 *   padd confluence pull [space] <page-id> [options]
 *   padd confluence push <file|dir>
 *   padd confluence sync [space] <page-id> [options]
 *
 * Legacy mode: .confluence.yaml defines both the space key and the space root.
 * New mode: confluence section in .padd.yaml is also supported transparently.
 *
 * confluence.yml:
 *   server: https://confluence.uhub.biz
 *   token:  your-PAT
 *   space:  WUNARGUA
 *
 * @module commands/confluence
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import readline from 'readline';
import { execSync } from 'child_process';
import { ConfluenceClient } from '../lib/confluence-client.js';
import { storageToMarkdown, slugifyTitle } from '../lib/confluence-converter.js';
import { preprocessMarkdown } from '../lib/md-preprocess.js';
import { getProviderCredentials } from '../lib/auth-storage.js';
import { loadCoreConfig } from '../lib/core-config.js';

// ─── Config Discovery ─────────────────────────────────────────────────────────

function parseSimpleYaml(text) {
  const result = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    result[key] = value === 'true' ? true : value === 'false' ? false : value;
  }
  return result;
}

/**
 * Walk up from startDir looking for .confluence.yaml files.
 * Merges them (closest overrides farthest), like CSS cascade.
 * Returns merged config + _spaceRoot (dir of closest config that has space key).
 */
function findConfluenceConfig(startDir) {
  const configs = [];
  let dir = path.resolve(startDir);
  const fsRoot = path.parse(dir).root;

  while (dir !== fsRoot) {
    const configPath = path.join(dir, '.confluence.yaml');
    if (fs.existsSync(configPath)) {
      const parsed = parseSimpleYaml(fs.readFileSync(configPath, 'utf8'));
      configs.push({ ...parsed, _dir: dir, _path: configPath });
    }
    dir = path.dirname(dir);
  }

  if (configs.length === 0) return null;

  // Merge: farthest provides defaults, closest overrides
  const merged = {};
  for (let i = configs.length - 1; i >= 0; i--) {
    Object.assign(merged, configs[i]);
  }

  // Normalize aliases: root_page_id → root_page
  if (merged.root_page_id && !merged.root_page) merged.root_page = merged.root_page_id;

  // Normalize aliases for server/token from .padd.yaml shapes.
  if (merged.base_url && !merged.server) merged.server = merged.base_url;
  if (merged.access_token && !merged.token && !merged.pat) merged.pat = merged.access_token;
  if (merged.token && !merged.pat) merged.pat = merged.token;

  // Space root = dir of the closest config that declares a space key
  const spaceConfig = configs.find(c => c.space);
  if (spaceConfig) {
    merged._spaceRoot = spaceConfig._dir;
  } else if (configs[0]) {
    merged._spaceRoot = configs[0]._dir;
  }

  return merged;
}

function loadConfluenceContext(startDir) {
  const legacy = findConfluenceConfig(startDir);

  let coreConfluence = null;
  let coreConfigPath = null;
  try {
    const core = loadCoreConfig({ startDir, required: false });
    coreConfluence = core?.config?.confluence || null;
    coreConfigPath = core?.configPath || null;
  } catch {
    // If core config fails, keep legacy behavior.
  }

  if (!legacy && (!coreConfluence || typeof coreConfluence !== 'object')) {
    return null;
  }

  // Precedence: .padd.yaml provides defaults; .confluence.yaml overrides locally.
  const normalized = {
    ...(coreConfluence && typeof coreConfluence === 'object' ? coreConfluence : {}),
    ...(legacy || {}),
  };

  if (coreConfigPath) {
    normalized._coreConfigPath = coreConfigPath;
  }

  if (normalized.root_page_id && !normalized.root_page) normalized.root_page = normalized.root_page_id;
  if (normalized.base_url && !normalized.server) normalized.server = normalized.base_url;
  if (normalized.access_token && !normalized.token && !normalized.pat) normalized.pat = normalized.access_token;
  if (normalized.token && !normalized.pat) normalized.pat = normalized.token;

  // Space root policy:
  // - If legacy .confluence.yaml exists, it defines the root (backward compatible).
  // - If only .padd.yaml is used, root is current working/search directory.
  if (!normalized._spaceRoot) {
    normalized._spaceRoot = path.resolve(startDir);
  }

  return normalized;
}

/**
 * Determine the space root folder.
 *
 *  --rootFolder <path>  → use that path directly (the path IS the root)
 *  confluence.yml found → the directory containing it IS the root
 *  otherwise           → current working directory
 */
function resolveSpaceRoot(rootFolderArg, config) {
  if (rootFolderArg) return path.resolve(rootFolderArg);
  if (config?._spaceRoot) return config._spaceRoot;
  return process.cwd();
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'y') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'n') return false;
  return fallback;
}

function getPullDefaults(config) {
  const pull = config?.pull || {};
  return {
    noParentsDefault: parseBoolean(
      pull.no_parents_default ?? config?.no_parents_default ?? config?.pull_no_parents_default,
      false
    ),
    autoAllOnEmptyManifest: parseBoolean(
      pull.auto_all_on_empty_manifest ?? config?.auto_all_on_empty_manifest ?? config?.pull_auto_all_on_empty_manifest,
      true
    ),
    bootstrapPageId:
      String(pull.bootstrap_page_id ?? config?.bootstrap_page_id ?? config?.pull_bootstrap_page_id ?? '').trim() || null,
  };
}

// ─── Manifest ────────────────────────────────────────────────────────────────

const MANIFEST_FILE = '.confluence-manifest.json';
const UNKNOWN_TAGS_FILE = '.confluence-tags.json';

function readManifest(spaceRoot) {
  const p = path.join(spaceRoot, MANIFEST_FILE);
  if (!fs.existsSync(p)) {
    const oldP = path.join(spaceRoot, '.padd-manifest.json');
    if (fs.existsSync(oldP)) fs.renameSync(oldP, p);
    else return { pages: {}, staged: [], remote: {} };
  }
  try {
    const m = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!m.staged) m.staged = [];
    if (!m.remote) m.remote = {};
    if (!m.pages) m.pages = {};

    // Deduplicate: if multiple PageIds share the same localPath, keep the one
    // whose PageId is found in the actual file on disk. Otherwise keep the entry
    // with the highest version (most recent push wins).
    const byPath = {};
    for (const [id, entry] of Object.entries(m.pages)) {
      if (!entry.localPath) continue;
      const existing = byPath[entry.localPath];
      if (!existing) { byPath[entry.localPath] = id; continue; }
      // Conflict — check which PageId the file on disk declares
      const filePath = path.join(spaceRoot, entry.localPath);
      if (fs.existsSync(filePath)) {
        const fileId = fs.readFileSync(filePath, 'utf8').match(/<!--\s*PageId:\s*(\d+)\s*-->/)?.[1];
        if (fileId === id) { byPath[entry.localPath] = id; continue; }
        if (fileId === existing) continue; // keep existing
      }
      // Fall back to higher version
      if ((entry.version ?? 0) > (m.pages[existing].version ?? 0)) {
        byPath[entry.localPath] = id;
      }
    }
    const keepIds = new Set(Object.values(byPath));
    for (const id of Object.keys(m.pages)) {
      if (m.pages[id].localPath && !keepIds.has(id)) delete m.pages[id];
    }

    // Deduplicate staged array
    m.staged = [...new Set(m.staged)];

    return m;
  } catch { return { pages: {}, staged: [], remote: {} }; }
}

function writeManifest(spaceRoot, manifest) {
  manifest.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(spaceRoot, MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf8');
}

function contentHash(str) {
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
}

/**
 * Scan markdown content for <!--[CONFLUENCE] ... --> wrappers and record
 * verbatim-only elements and unrecognized macros into tagRecords.
 * Verbatim-only: no <!--[/CONFLUENCE]--> follows (no markdown equivalent).
 * Unknown macro: markdown equivalent is only a <!-- confluence-macro: --> comment.
 */
function extractTagOccurrences(content, relPath, tagRecords) {
  if (!tagRecords) return;
  const lines = content.split('\n');
  let i = 0;
  while (i < lines.length) {
    if (lines[i] !== '<!--[CONFLUENCE]') { i++; continue; }
    // Collect raw XML lines between <!--[CONFLUENCE] and -->
    const xmlLines = [];
    let j = i + 1;
    while (j < lines.length && lines[j] !== '-->') { xmlLines.push(lines[j]); j++; }
    const rawSnippet = xmlLines.join('\n').trim().replace(/--\u00B7>/g, '-->');
    if (!rawSnippet) { i = j + 1; continue; }
    // Identify tag
    let tag;
    const macroMatch = rawSnippet.match(/ac:structured-macro[^>]*ac:name="([^"]+)"/i);
    if (macroMatch) {
      tag = `macro:${macroMatch[1]}`;
    } else {
      const tagMatch = rawSnippet.match(/^<((?:ac|ri|at):[a-z][a-z0-9-]*)/i);
      if (!tagMatch) { i = j + 1; continue; }
      tag = tagMatch[1];
    }
    // Determine whether to record: verbatim-only OR unrecognized macro
    let k = j + 1;
    while (k < lines.length && lines[k].trim() === '') k++;
    const hasCloser = k < lines.length && lines[k].trim() === '<!--[/CONFLUENCE]-->';
    const mdContent = hasCloser ? lines.slice(j + 1, k).join('\n').trim() : '';
    const isVerbatimOnly = !hasCloser;
    const isUnknownMacro = hasCloser && mdContent.includes('confluence-macro:');
    if (isVerbatimOnly || isUnknownMacro) {
      tagRecords.push({ tag, file: relPath, line: i + 2, snippet: rawSnippet.slice(0, 200) });
    }
    i = j + 1;
  }
}

/**
 * Read existing confluence-tags.json, merge new records (dedup by tag+file+line),
 * sort, and write back. Returns count of newly added records.
 */
function saveTagRecords(spaceRoot, newRecords) {
  if (!newRecords || newRecords.length === 0) return 0;
  const filePath = path.join(spaceRoot, UNKNOWN_TAGS_FILE);
  let existing = { updated: '', records: [] };
  if (fs.existsSync(filePath)) {
    try { existing = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch { existing = { updated: '', records: [] }; }
  }
  if (!Array.isArray(existing.records)) existing.records = [];
  const seen = new Set(existing.records.map(r => `${r.tag}|${r.file}|${r.line}`));
  let added = 0;
  for (const rec of newRecords) {
    const key = `${rec.tag}|${rec.file}|${rec.line}`;
    if (!seen.has(key)) { existing.records.push(rec); seen.add(key); added++; }
  }
  existing.records.sort((a, b) =>
    a.tag.localeCompare(b.tag) || a.file.localeCompare(b.file) || a.line - b.line
  );
  existing.updated = new Date().toISOString();
  fs.writeFileSync(filePath, JSON.stringify(existing, null, 2), 'utf8');
  return added;
}

async function promptYNA(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    const ask = () => rl.question(question, answer => {
      const a = answer.trim().toLowerCase();
      if (a === 'y' || a === 'n' || a === 'a') { rl.close(); resolve(a); }
      else ask();
    });
    ask();
  });
}

async function promptConfirm(question, defaultYes = true) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(defaultYes ? a !== 'n' : a === 'y' || a === 'yes');
    });
  });
}

/**
 * Diff remote page list against local manifest.
 * Returns pages to download (new/changed) and entries to delete (gone on remote).
 */
function getRemoteParentId(remotePage) {
  const ancestors = (remotePage.ancestors || []).filter(a => a.type === 'page');
  return ancestors.length > 0 ? String(ancestors[ancestors.length - 1].id) : null;
}

function diffManifest(remotePages, manifest, spaceRoot) {
  const remote = new Map(remotePages.map(p => [String(p.id), p]));
  const local = manifest.pages || {};

  const toDownload = [];
  const toDelete = [];

  for (const [id, remotePage] of remote) {
    const entry = local[id];
    if (!entry) {
      toDownload.push({ ...remotePage, _reason: 'new' });
    } else if (remotePage.version.number > entry.version) {
      toDownload.push({ ...remotePage, _reason: 'changed', _localPath: entry.localPath });
    } else if (spaceRoot && entry.localPath && !fs.existsSync(path.join(spaceRoot, entry.localPath))) {
      // Local file missing even though version matches — re-download
      toDownload.push({ ...remotePage, _reason: 'changed', _localPath: null });
    } else {
      // Check if page was moved (parent changed) — Confluence doesn't bump version on move
      const remoteParentId = getRemoteParentId(remotePage);
      if (entry.parentId !== undefined && entry.parentId !== remoteParentId) {
        toDownload.push({ ...remotePage, _reason: 'moved', _localPath: entry.localPath });
      }
    }
  }

  for (const [id, entry] of Object.entries(local)) {
    if (!remote.has(id)) toDelete.push({ id, ...entry });
  }

  return { toDownload, toDelete };
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

function getClient(config) {
  const server = config?.server || config?.base_url;
  const token = config?.token || config?.pat || config?.access_token;

  if (server && token) {
    return new ConfluenceClient({ baseUrl: server, pat: token, type: 'server' });
  }

  const creds = getProviderCredentials('confluence');
  if (!creds) {
    console.error('\n❌ No Confluence credentials found.');
      console.error('   Add server + token to .confluence.yaml, or run: padd auth refresh confluence\n');
    process.exit(1);
  }
  return new ConfluenceClient({
    baseUrl: creds.base_url,
    pat: creds.pat,
    username: creds.username,
    apiToken: creds.api_token,
    type: creds.type,
  });
}

// ─── Page File Helpers ────────────────────────────────────────────────────────

/**
 * Compute the local relative path for a page within the space root.
 *
 * @param {Object} page          Full page object with .ancestors[]
 * @param {string} rootParentId  Strip ancestors up to+including this ID (--no-parents)
 * @param {boolean} flat         Place directly in space root (--flat)
 */
function getPageRelativePath(page, rootParentId, flat) {
  if (flat) return slugifyTitle(page.title) + '.md';

  let ancestors = (page.ancestors || []).filter(a => a.type === 'page');

  if (rootParentId) {
    const idx = ancestors.findIndex(a => a.id === String(rootParentId));
    ancestors = idx !== -1 ? ancestors.slice(idx + 1) : [];
  }

  const parts = ancestors.map(a => slugifyTitle(a.title));
  return path.join(...parts, slugifyTitle(page.title) + '.md');
}

function buildMarkHeaders(page) {
  const space = page.space?.key || '';
  const ancestors = page.ancestors || [];
  const parent = ancestors.length > 0 ? ancestors[ancestors.length - 1].title : null;
  let h = `<!-- Space: ${space} -->\n`;
  if (parent) h += `<!-- Parent: ${parent} -->\n`;
  h += `<!-- Title: ${page.title} -->\n`;
  h += `<!-- PageId: ${page.id} -->\n`;
  return h;
}

function buildPageContent(page, baseUrl, titleToRelPath, currentRelPath) {
  const headers = buildMarkHeaders(page);
  const rawMarkdown = storageToMarkdown(page.body?.storage?.value || '', { baseUrl, pageId: page.id, titleToRelPath, currentRelPath });
  const titleHeading = `${page.title}\n${'='.repeat(page.title.length)}\n\n`;
  return headers + '\n' + titleHeading + rawMarkdown;
}

/** Rename a slug-named subfolder when a page title changes. Returns log message or null. */
function renameSlugFolder(baseDir, oldTitle, newTitle) {
  if (!oldTitle || !newTitle || oldTitle === newTitle) return null;
  const oldSlug = slugifyTitle(oldTitle);
  const newSlug = slugifyTitle(newTitle);
  if (oldSlug === newSlug) return null;
  const oldFolder = path.join(baseDir, oldSlug);
  const newFolder = path.join(baseDir, newSlug);
  if (fs.existsSync(oldFolder) && fs.statSync(oldFolder).isDirectory()) {
    fs.renameSync(oldFolder, newFolder);
    return `${oldSlug}/ → ${newSlug}/`;
  }
  return null;
}

async function writePageFile(page, spaceRoot, rootParentId, flat, manifest = null, baseUrl = '', debugHtml = false, tagRecords = null) {
  const relPath = getPageRelativePath(page, rootParentId, flat);
  const filepath = path.join(spaceRoot, relPath);

  // Move/rename detection: delete old local file if the page's path changed
  const prevEntry = manifest?.pages?.[String(page.id)];
  if (prevEntry?.localPath && prevEntry.localPath !== relPath) {
    const oldFilepath = path.join(spaceRoot, prevEntry.localPath);
    if (fs.existsSync(oldFilepath)) fs.unlinkSync(oldFilepath);
  }

  fs.mkdirSync(path.dirname(filepath), { recursive: true });

  const titleToRelPath = Object.fromEntries(
    Object.values(manifest?.pages || {})
      .filter(e => e.title && e.localPath)
      .map(e => [e.title, e.localPath])
  );
  const content = buildPageContent(page, baseUrl, titleToRelPath, relPath);

  fs.writeFileSync(filepath, content, 'utf8');
  extractTagOccurrences(content, relPath, tagRecords);

  if (debugHtml) {
    const htmlPath = filepath.replace(/\.md$/, '.html');
    fs.writeFileSync(htmlPath, page.body?.storage?.value || '', 'utf8');
  }

  if (manifest) {
    manifest.pages[String(page.id)] = {
      version: page.version?.number ?? 0,
      title: page.title,
      localPath: relPath,
      parentId: getRemoteParentId(page),
      hash: contentHash(content),
    };
  }

  const icon = prevEntry ? '↓' : '+';
  console.log(`  ${icon} ${relPath}`);
  return relPath;
}

// ─── Pull ─────────────────────────────────────────────────────────────────────

/** Scan spaceRoot for all .md files that contain a <!-- PageId: --> header. */
function scanTrackedPages(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === '.confluence.yaml') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanTrackedPages(full, results);
    } else if (entry.name.endsWith('.md')) {
      const content = fs.readFileSync(full, 'utf8');
      const match = content.match(/<!--\s*PageId:\s*(\d+)\s*-->/);
      if (match) results.push({ filepath: full, pageId: match[1] });
    }
  }
  return results;
}

/** Delete .md files whose PageId exists in the manifest but at a different localPath (orphans after moves). */
function cleanOrphanFiles(spaceRoot, manifest) {
  const diskFiles = scanTrackedPages(spaceRoot);
  for (const { filepath, pageId } of diskFiles) {
    const entry = manifest.pages?.[pageId];
    if (!entry) continue;
    const relPath = path.relative(spaceRoot, filepath).replace(/\\/g, '/');
    if (relPath !== entry.localPath) {
      fs.unlinkSync(filepath);
      console.log(`  - ${relPath}  (moved to ${entry.localPath})`);
    }
  }
}

async function downloadChildren(client, parentPage, spaceRoot, rootParentId, maxDepth, currentDepth, flat, manifest = null, baseUrl = '', debugHtml = false, tagRecords = null) {
  if (currentDepth > maxDepth) return 0;
  let count = 0;
  const children = await client.getChildPages(parentPage.id);
  for (const child of children) {
    const fullChild = await client.getPage(child.id, 'body.storage,version,space,ancestors');
    await writePageFile(fullChild, spaceRoot, rootParentId, flat, manifest, baseUrl, debugHtml, tagRecords);
    count++;
    count += await downloadChildren(client, fullChild, spaceRoot, rootParentId, maxDepth, currentDepth + 1, flat, manifest, baseUrl, debugHtml, tagRecords);
  }
  return count;
}

async function runPull(args) {
  const opts = parsePullArgs(args);

  const searchDir = opts.rootFolder ? path.resolve(opts.rootFolder) : process.cwd();
  const config = loadConfluenceContext(searchDir);
  const pullDefaults = getPullDefaults(config);

  if (!opts.noParents && !opts.flat && pullDefaults.noParentsDefault) {
    opts.noParents = true;
  }

  const spaceKey = opts.spaceKey || config?.space;
  const spaceRoot = resolveSpaceRoot(opts.rootFolder, config);
  const client = getClient(config);
  const baseUrl = (config?.server || config?.base_url || '').replace(/\/$/, '');
  const debugHtml = !!(config?.debug);
  const tagRecords = debugHtml ? [] : null;

  // ── Case 1: --all → full space diff (CQL + manifest, only new/changed) ──────
  if (opts.all) {
    const rootPageId = config?.root_page;
    if (!rootPageId) {
      console.error('\n❌ --all requires root_page (or root_page_id) in Confluence config');
      console.error('   Add:  root_page: <space-home-page-id>');
      console.error('   Or:   padd confluence init <space> --root-page <id>\n');
      process.exit(1);
    }
    fs.mkdirSync(spaceRoot, { recursive: true });
    const resolvedSpace = spaceKey || '';
    const remotePages = await client.getSpacePageList(resolvedSpace, rootPageId);
    const manifest = readManifest(spaceRoot);
    manifest.space = resolvedSpace;
    manifest.rootPage = String(rootPageId);
    if (!manifest.pages) manifest.pages = {};
    const { toDownload, toDelete } = diffManifest(remotePages, manifest, spaceRoot);

    if (toDownload.length === 0 && toDelete.length === 0) {
      console.log('  Already up to date.\n');
      writeManifest(spaceRoot, manifest);
      return;
    }

    // Preview
    const newPages = toDownload.filter(p => p._reason === 'new');
    const changedPages = toDownload.filter(p => p._reason === 'changed');
    const summaryParts = [
      newPages.length     && `  + ${newPages.length} new`,
      changedPages.length && `  ↑ ${changedPages.length} changed`,
      toDelete.length     && `  - ${toDelete.length} deleted`,
    ].filter(Boolean);
    console.log(summaryParts.join('\n'));

    if (toDownload.length > 0) {
      const secs = toDownload.length; // ~1s per page (one API call each)
      const timeStr = secs < 60 ? `~${secs}s` : `~${Math.ceil(secs / 60)}min`;
      console.log(`\n  Estimated time: ${timeStr} (${toDownload.length} pages to fetch)`);
    }

    if (!opts.yes) {
      const ok = await promptConfirm('\n  Proceed? [Y/n] ');
      if (!ok) { console.log('  Aborted.\n'); return; }
    }
    console.log();

    for (const page of toDownload) {
      const fullPage = await client.getPage(page.id, 'body.storage,version,space,ancestors');
      const localPath = page._localPath;
      const relPath = localPath || getPageRelativePath(fullPage, null, false);
      const filepath = path.join(spaceRoot, relPath);
      fs.mkdirSync(path.dirname(filepath), { recursive: true });
      const titleToRelPath = Object.fromEntries(
        Object.values(manifest?.pages || {}).filter(e => e.title && e.localPath).map(e => [e.title, e.localPath])
      );
      const content = buildPageContent(fullPage, baseUrl, titleToRelPath, relPath);
      fs.writeFileSync(filepath, content, 'utf8');
      extractTagOccurrences(content, relPath, tagRecords);
      if (debugHtml) fs.writeFileSync(filepath.replace(/\.md$/, '.html'), fullPage.body?.storage?.value || '', 'utf8');
      manifest.pages[String(page.id)] = {
        version: fullPage.version?.number ?? 0,
        title: fullPage.title,
        localPath: relPath,
        parentId: getRemoteParentId(fullPage),
        hash: contentHash(content),
      };
      const icon = page._reason === 'new' ? '+' : page._reason === 'moved' ? '→' : '↓';
      console.log(`  ${icon} ${relPath}`);
    }
    for (const entry of toDelete) {
      const filepath = path.join(spaceRoot, entry.localPath);
      if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
      delete manifest.pages[String(entry.id)];
      console.log(`  - ${entry.localPath}`);
    }
    writeManifest(spaceRoot, manifest);
    cleanOrphanFiles(spaceRoot, manifest);
    const allParts = [toDownload.length && `${toDownload.length} updated`, toDelete.length && `${toDelete.length} deleted`].filter(Boolean);
    if (allParts.length) console.log(`\n✓ ${allParts.join(', ')}.\n`);
    else console.log('Already up to date.');
    return;
  }

  // ── Case 2: no page ID → manifest-based smart sync ───────────────────────
  if (!opts.pageId) {
    if (!fs.existsSync(spaceRoot)) {
      console.error('\n❌ No page ID and no local pages found.');
      console.error('   Pull a first page:  padd confluence pull <page-id>');
      console.error('   Or pull everything: padd confluence pull --all\n');
      process.exit(1);
    }

    const manifest = readManifest(spaceRoot);
    const resolvedSpace = spaceKey || manifest.space || '';
    const rootPageId = config?.root_page || manifest.rootPage;

    if (Object.keys(manifest.pages).length === 0) {
      if (rootPageId) {
        if (opts.all || pullDefaults.autoAllOnEmptyManifest) {
          // No tracked pages and auto-all enabled — bootstrap with full pull.
          // This preserves legacy behavior unless config opts out.
          opts.all = true;
        } else {
          // Safer bootstrap: only bootstrap explicitly configured page.
          const bootstrapPageId = pullDefaults.bootstrapPageId;
          if (!bootstrapPageId) {
            console.error('\n❌ Empty manifest and auto-all bootstrap is disabled.');
            console.error('   No pages were downloaded.');
            console.error('   Next step:');
            console.error('   - pull one page explicitly: padd confluence pull <page-id>');
            console.error('   - or enable auto bootstrap: confluence.pull.auto_all_on_empty_manifest: true');
            console.error('   - or set bootstrap page: confluence.pull.bootstrap_page_id: <page-id>\n');
            process.exit(1);
          }

          // Start tracking with one explicit page, not whole tree.
          const page = await client.getPage(bootstrapPageId, 'body.storage,version,space,ancestors');

          await writePageFile(
            page,
            spaceRoot,
            opts.noParents && page.ancestors?.length > 0
              ? page.ancestors[page.ancestors.length - 1].id
              : null,
            !!opts.flat,
            manifest,
            baseUrl,
            debugHtml,
            tagRecords
          );

          manifest.space = page.space?.key || resolvedSpace || manifest.space;
          if (rootPageId) manifest.rootPage = String(rootPageId);
          writeManifest(spaceRoot, manifest);
          cleanOrphanFiles(spaceRoot, manifest);
          console.log('\n✓ 1 page bootstrapped (manifest initialized without full tree pull).\n');
          return;
        }
      } else {
        console.error('\n❌ Nothing tracked yet. Run: padd confluence pull <page-id>\n');
        process.exit(1);
      }
    }

    // Without rootPage we can't do a smart diff — fall back to refetch tracked pages
    if (!rootPageId) {
      console.warn(`  ⚠  No root_page_id configured — fetching all tracked pages individually.`);
      for (const [id, entry] of Object.entries(manifest.pages)) {
        try {
          const page = await client.getPage(id, 'body.storage,version,space,ancestors');
          const titleToRelPath = Object.fromEntries(
            Object.values(manifest?.pages || {}).filter(e => e.title && e.localPath).map(e => [e.title, e.localPath])
          );
          const content = buildPageContent(page, baseUrl, titleToRelPath, entry.localPath);
          const localFilepath = path.join(spaceRoot, entry.localPath);
          fs.writeFileSync(localFilepath, content, 'utf8');
          extractTagOccurrences(content, entry.localPath, tagRecords);
          if (debugHtml) fs.writeFileSync(localFilepath.replace(/\.md$/, '.html'), page.body?.storage?.value || '', 'utf8');
          manifest.pages[id] = { ...entry, version: page.version?.number ?? 0, parentId: getRemoteParentId(page), hash: contentHash(content) };
          console.log(`  ↓ ${entry.localPath}`);
        } catch (e) {
          if (e.message?.includes('404')) {
            const localFilepath = path.join(spaceRoot, entry.localPath);
            if (fs.existsSync(localFilepath)) fs.unlinkSync(localFilepath);
            delete manifest.pages[id];
            console.log(`  - ${entry.localPath}`);
          } else throw e;
        }
      }
      writeManifest(spaceRoot, manifest);
      return;
    }

    const remotePages = await client.getSpacePageList(resolvedSpace, rootPageId);
    const { toDownload, toDelete } = diffManifest(remotePages, manifest, spaceRoot);

    if (toDownload.length === 0 && toDelete.length === 0) {
      console.log('Already up to date.');
      return;
    }

    // Detect local modifications before overwriting
    if (!opts.force) {
      const conflicts = toDownload.filter(p => {
        const localPath = p._localPath || manifest.pages[String(p.id)]?.localPath;
        if (!localPath) return false;
        const filepath = path.join(spaceRoot, localPath);
        if (!fs.existsSync(filepath)) return false;
        const storedHash = manifest.pages[String(p.id)]?.hash;
        return storedHash && contentHash(fs.readFileSync(filepath, 'utf8')) !== storedHash;
      });
      if (conflicts.length > 0) {
        console.error('\n⚠  Local modifications detected in:');
        for (const p of conflicts) {
          console.error(`   ${manifest.pages[String(p.id)]?.localPath}  [${p.id}]`);
        }
        console.error('\n   Push first, or use --force to overwrite.\n');
        process.exit(1);
      }
    }

    // Download new/changed
    let downloaded = 0;
    for (const page of toDownload) {
      const fullPage = await client.getPage(page.id, 'body.storage,version,space,ancestors');
      const localPath = page._localPath; // preserve existing path for changed pages
      const manifestEntry = manifest.pages[String(page.id)];
      const titleChanged = manifestEntry && fullPage.title !== manifestEntry.title;

      let relPath;
      if (titleChanged && localPath) {
        // Title changed on Confluence — derive new path and rename local file+folder
        relPath = getPageRelativePath(fullPage, null, false);
        const oldFilepath = path.join(spaceRoot, localPath);
        if (fs.existsSync(oldFilepath)) fs.unlinkSync(oldFilepath);
        const renamed = renameSlugFolder(path.dirname(oldFilepath), manifestEntry.title, fullPage.title);
        if (renamed) console.log(`  ↻ ${renamed}`);
      } else {
        relPath = localPath || getPageRelativePath(fullPage, null, false);
      }
      const filepath = path.join(spaceRoot, relPath);
      fs.mkdirSync(path.dirname(filepath), { recursive: true });
      const titleToRelPath = Object.fromEntries(
        Object.values(manifest?.pages || {}).filter(e => e.title && e.localPath).map(e => [e.title, e.localPath])
      );
      const content = buildPageContent(fullPage, baseUrl, titleToRelPath, relPath);
      fs.writeFileSync(filepath, content, 'utf8');
      extractTagOccurrences(content, relPath, tagRecords);
      if (debugHtml) fs.writeFileSync(filepath.replace(/\.md$/, '.html'), fullPage.body?.storage?.value || '', 'utf8');
      manifest.pages[String(page.id)] = {
        version: fullPage.version?.number ?? 0,
        title: fullPage.title,
        localPath: relPath,
        parentId: getRemoteParentId(fullPage),
        hash: contentHash(content),
      };
      const icon = page._reason === 'new' ? '+' : page._reason === 'moved' ? '→' : '↓';
      console.log(`  ${icon} ${relPath}`);
      downloaded++;
    }

    // Delete pages removed on Confluence
    let deleted = 0;
    for (const entry of toDelete) {
      const filepath = path.join(spaceRoot, entry.localPath);
      if (fs.existsSync(filepath)) {
        const currentHash = contentHash(fs.readFileSync(filepath, 'utf8'));
        if (currentHash !== entry.hash && !opts.force) {
          console.log(`  ○ ${entry.localPath}  (deleted on remote, has local changes — push first or use --force)`);
          continue;
        }
        fs.unlinkSync(filepath);
        console.log(`  - ${entry.localPath}`);
      }
      delete manifest.pages[String(entry.id)];
      deleted++;
    }

    writeManifest(spaceRoot, manifest);
    cleanOrphanFiles(spaceRoot, manifest);
    const syncParts = [downloaded && `${downloaded} updated`, deleted && `${deleted} deleted`].filter(Boolean);
    if (syncParts.length) console.log(`\n✓ ${syncParts.join(', ')}.`);
    return;
  }

  // ── Case 3: specific page ID ──────────────────────────────────────────────
  fs.mkdirSync(spaceRoot, { recursive: true });

  const manifest = readManifest(spaceRoot);
  if (!manifest.pages) manifest.pages = {};

  const page = await client.getPage(opts.pageId, 'body.storage,version,space,ancestors');

  const targetParentId = opts.noParents
    ? (page.ancestors?.length > 0 ? page.ancestors[page.ancestors.length - 1].id : null)
    : null;

  let total = 0;

  if (opts.flat) {
    await writePageFile(page, spaceRoot, null, true, manifest, baseUrl, debugHtml, tagRecords);
    total++;
    if (opts.childDepth > 0) total += await downloadChildren(client, page, spaceRoot, null, opts.childDepth, 1, true, manifest, baseUrl, debugHtml, tagRecords);

  } else if (opts.noParents) {
    await writePageFile(page, spaceRoot, targetParentId, false, manifest, baseUrl, debugHtml, tagRecords);
    total++;
    if (opts.childDepth > 0) total += await downloadChildren(client, page, spaceRoot, targetParentId, opts.childDepth, 1, false, manifest, baseUrl, debugHtml, tagRecords);

  } else {
    for (const ancestor of page.ancestors || []) {
      const ancestorPage = await client.getPage(ancestor.id, 'body.storage,version,space,ancestors');
      const relPath = getPageRelativePath(ancestorPage, null, false);
      if (fs.existsSync(path.join(spaceRoot, relPath))) {
        // ancestor already local — skip silently
      } else {
        await writePageFile(ancestorPage, spaceRoot, null, false, manifest, baseUrl, debugHtml, tagRecords);
        total++;
      }
    }
    await writePageFile(page, spaceRoot, null, false, manifest, baseUrl, debugHtml, tagRecords);
    total++;
    if (opts.childDepth > 0) total += await downloadChildren(client, page, spaceRoot, null, opts.childDepth, 1, false, manifest, baseUrl, debugHtml, tagRecords);
  }

  // Auto-create .confluence.yaml if missing
  const ymlPath = path.join(spaceRoot, '.confluence.yaml');
  if (!fs.existsSync(ymlPath)) {
    const server = config?.server || config?.base_url
      || (() => { try { return getProviderCredentials('confluence')?.base_url; } catch { return ''; } })() || '';
    const spaceKeyResolved = page.space?.key || spaceKey || '';
    fs.writeFileSync(ymlPath,
      `# Confluence space config — add token: <your-PAT> to authenticate from this folder\nserver: ${server}\nspace: ${spaceKeyResolved}\n`,
      'utf8');
    console.log(`\n  ✎ Created .confluence.yaml in ${spaceRoot}`);
  }

  writeManifest(spaceRoot, manifest);
  cleanOrphanFiles(spaceRoot, manifest);
  if (total > 1) console.log(`\n✓ ${total} pages.`);


  if (debugHtml) {
    if (tagRecords?.length > 0) {
      const added = saveTagRecords(spaceRoot, tagRecords);
      const uniqueTags = [...new Set(tagRecords.map(r => r.tag))].sort();
      console.log(`⚙  Unhandled Confluence elements (${tagRecords.length} occurrence(s), ${uniqueTags.length} unique):`);
      for (const tag of uniqueTags) {
        const count = tagRecords.filter(r => r.tag === tag).length;
        console.log(`     ${tag}  (${count}x)`);
      }
      console.log(`   → ${added} new record(s) saved to ${UNKNOWN_TAGS_FILE}\n`);
    } else {
      console.log(`⚙  No unhandled Confluence elements found.\n`);
    }
  }
}

// ─── Push ─────────────────────────────────────────────────────────────────────

function requireMark() {
  try {
    execSync('mark --version', { stdio: 'ignore' });
  } catch {
    console.error('\n❌ mark is not installed.');
    console.error('   Install: brew tap kovetskiy/mark && brew install mark');
    console.error('   Config:  ~/.config/mark.toml  (base-url + token)\n');
    process.exit(1);
  }
}

function findMdFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findMdFiles(full));
    else if (entry.name.endsWith('.md')) results.push(full);
  }
  return results;
}

/**
 * Extract all <!--[CONFLUENCE]...--> blocks, replacing each with a unique string
 * placeholder. Returns { stripped, blocks: [{placeholder, xml}] }.
 * Handles both verbatim-only blocks and blocks with <!--[/CONFLUENCE]--> closers.
 * Use this instead of restoreConfluenceTags when pushing: mark receives clean
 * markdown, then a post-push API fixup injects the real Confluence XML.
 */
function extractVerbatimBlocks(content) {
  const blocks = [];
  let idx = 0;
  let result = content;
  let prev;
  do {
    prev = result;
    // Blocks with single-line markdown alternative + <!--[/CONFLUENCE]--> closer.
    // ((?:(?!\n-->)[\s\S])*) = tempered greedy token: matches any char that is NOT the
    // start of \n-->, so it stops at the first \n--> without backtracking across blocks.
    // Supports multi-line XML unlike [^\n]+.
    result = result.replace(
      /<!--\[CONFLUENCE\]\n((?:(?!\n-->)[\s\S])*)\n-->\n[^\n]*\n<!--\[\/CONFLUENCE\]-->/g,
      (_, xml) => {
        const id = `PADD-MACRO-${idx++}`;
        // Wrap in backticks so mark renders as <code>id</code> (plain __id__ would become <strong>)
        blocks.push({ id, xml: xml.replace(/--\u00B7>/g, '-->') });
        return `\`${id}\``;
      }
    );
    // Verbatim-only blocks (no closer). Same tempered greedy token prevents backtracking.
    result = result.replace(
      /<!--\[CONFLUENCE\]\n((?:(?!\n-->)[\s\S])*)\n-->/g,
      (_, xml) => {
        const id = `PADD-MACRO-${idx++}`;
        blocks.push({ id, xml: xml.replace(/--\u00B7>/g, '-->') });
        return `\`${id}\``;
      }
    );
  } while (result !== prev);
  return { stripped: result, blocks };
}

/**
 * Restore <!--[CONFLUENCE]\nXML\n-->...<!--[/CONFLUENCE]--> wrappers back to
 * original Confluence XML before pushing. Handles nesting via iterative passes.
 */
function restoreConfluenceTags(content) {
  let result = content;
  let prev;
  do {
    prev = result;
    // Blocks with markdown representation
    result = result.replace(
      /<!--\[CONFLUENCE\]\n([\s\S]*?)\n-->\n[\s\S]*?<!--\[\/CONFLUENCE\]-->/g,
      (_, original) => original.replace(/--\u00B7>/g, '-->')
    );
    // Verbatim-only blocks (no markdown equivalent)
    result = result.replace(
      /<!--\[CONFLUENCE\]\n([\s\S]*?)\n-->/g,
      (_, original) => original.replace(/--\u00B7>/g, '-->')
    );
  } while (result !== prev);
  return result;
}

/**
 * Convert relative .md links to Confluence <ac:link> XML for same-space pages.
 * Links to absolute URLs are left untouched (they render as standard HTML links).
 * @param {string} content   - Markdown content of the page being pushed
 * @param {string} filePath  - Absolute path of the current .md file
 * @param {string} spaceRoot - Absolute path of the Confluence space root
 * @returns {string} Content with relative .md links replaced by ac:link XML
 */
function convertRelativeMdLinks(content, filePath, spaceRoot) {
  const resolvedRoot = path.resolve(spaceRoot);
  // [~~Page Title~~](slug) → <ac:link> (unresolved same-space page references from pull)
  // The ~~ inside link text is the marker; stripped before using as ri:content-title.
  content = content.replace(/\[~~([^~]+)~~\]\([^)]*\)/g, (full, title) => {
    return `<ac:link><ri:page ri:content-title="${title}"/></ac:link>`;
  });
  return content.replace(/\[([^\]]+)\]\(([^)]+\.md(?:#[^)]*)?)\)/g, (full, text, href) => {
    if (/^https?:\/\//.test(href)) return full;
    const [mdPath, anchor] = href.split('#');
    const resolved = path.resolve(path.dirname(filePath), mdPath);
    if (!resolved.startsWith(resolvedRoot)) return full;
    let title;
    try {
      const target = fs.readFileSync(resolved, 'utf8');
      title = target.match(/<!--\s*Title:\s*(.+?)\s*-->/)?.[1];
      if (!title) {
        title = target.match(/^#\s+(.+)$/m)?.[1] ||
                target.match(/^(.+)\n=+/m)?.[1] ||
                path.basename(mdPath, '.md');
      }
    } catch {
      return full;
    }
    const anchorAttr = anchor ? ` ri:anchor="${anchor}"` : '';
    const linkBody = text !== title
      ? `<ac:plain-text-link-body><![CDATA[${text}]]></ac:plain-text-link-body>`
      : '';
    return `<ac:link><ri:page ri:content-title="${title}"${anchorAttr}/>${linkBody}</ac:link>`;
  });
}

/** Convert a filename like 'my_test_page' → 'My Test Page'. */
function filenameToTitle(filepath) {
  return path.basename(filepath, '.md')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Build mark-compatible headers for a new file that has no <!-- Space: --> header.
 * Title comes from the first # H1 in the file, falling back to the filename.
 * Parent comes from the manifest root page (if known).
 */
function buildHeadersForNewFile(raw, filepath, config, manifest) {
  const spaceKey = config?.space || '';
  const setextMatch = raw.match(/^(.+)\n={2,}/m);
  const atxMatch = raw.match(/^#\s+(.+)$/m);
  const title = setextMatch ? setextMatch[1].trim() : (atxMatch ? atxMatch[1].trim() : filenameToTitle(filepath));

  // Detect parent from folder structure: if file is in subdir, look for matching .md in parent dir
  const spaceRoot = config?._spaceRoot || '';
  const fileDir = path.dirname(path.resolve(filepath));
  const dirName = path.basename(fileDir);
  const parentDirMd = path.join(fileDir, '..', dirName + '.md');
  let parent = null;
  if (spaceRoot && fileDir !== path.resolve(spaceRoot) && fs.existsSync(parentDirMd)) {
    const parentContent = fs.readFileSync(parentDirMd, 'utf8');
    parent = parentContent.match(/<!--\s*Title:\s*(.+?)\s*-->/)?.[1] || null;
  }

  // Fallback to space root page
  const rootPageId = config?.root_page || config?.root_page_id || manifest.rootPage || null;
  if (!parent) {
    parent = rootPageId ? manifest.pages?.[String(rootPageId)]?.title : null;
  }

  let headers = `<!-- Space: ${spaceKey} -->\n`;
  if (rootPageId) headers += `<!-- ParentPageId: ${rootPageId} -->\n`;
  if (parent) headers += `<!-- Parent: ${parent} -->\n`;
  headers += `<!-- Title: ${title} -->\n`;
  return { headers, title };
}

async function runPush(args) {
  const explicitTarget = args.find(a => !a.startsWith('-'));
  const includeChilds = args.includes('--include-childs');
  const forceHash = args.includes('--force');           // skip hash check, respect staging
  const cleanOnly = args.includes('--clean');
  const verbose   = args.includes('--verbose') || args.includes('-v');
  const target = explicitTarget || '.';

  const targetPath = path.resolve(target);
  if (!fs.existsSync(targetPath)) {
    console.error(`\n❌ Not found: ${targetPath}\n`);
    process.exit(1);
  }

  const stat = fs.statSync(targetPath);
  const searchDir = stat.isDirectory() ? targetPath : path.dirname(targetPath);
  const config = loadConfluenceContext(searchDir);
  const debugHtml = !!(config?.debug);
  const spaceRoot = config?._spaceRoot || searchDir;

  // Read manifest early so we can use staged list and avoid double-read
  const manifest = readManifest(spaceRoot);

  // Build file list, optionally including children of a single file target
  let files;
  if (stat.isFile()) {
    files = [targetPath];
    if (includeChilds) {
      const childDir = targetPath.replace(/\.md$/, '');
      if (fs.existsSync(childDir) && fs.statSync(childDir).isDirectory()) {
        files.push(...findMdFiles(childDir));
      }
    }
  } else {
    const scanDir = explicitTarget ? targetPath : spaceRoot;
    files = findMdFiles(scanDir);
  }

  // Git-like staging: when no explicit target, restrict to staged files only
  if (!explicitTarget && !cleanOnly) {
    const staged = manifest.staged || [];
    if (staged.length === 0) {
      console.log('\nNothing staged. Use "padd confluence add <file>" to stage files for push.\n');
      console.log('  Tip: "padd confluence add ." to stage all modified and new files.\n');
      return;
    }
    const stagedSet = new Set(staged.map(p => path.join(spaceRoot, p)));
    files = files.filter(f => stagedSet.has(f));
  }

  // Sort shallowest first so parents always push before their children
  files.sort((a, b) => {
    const depthDiff = a.split(path.sep).length - b.split(path.sep).length;
    return depthDiff !== 0 ? depthDiff : a.localeCompare(b);
  });

  if (files.length === 0 && !cleanOnly) {
    console.error('\n❌ No .md files found.\n');
    process.exit(1);
  }

  if (debugHtml) {
    console.log(`\n⚙  debug mode — push skipped. Writing snapshot files...\n`);
    for (const f of files) {
      const htmlPath = f.replace(/\.md$/, '_confluence.html');
      fs.writeFileSync(htmlPath, fs.readFileSync(f, 'utf8'), 'utf8');
      console.log(`  ○ ${path.relative(searchDir, f)} → ${path.basename(htmlPath)}`);
    }
    console.log(`\n  (Set debug: false in .confluence.yaml to push for real)\n`);
    return;
  }

  requireMark();

  // Pass credentials from .confluence.yaml directly to mark — no separate mark config needed
  const markServer = (config?.server || config?.base_url || '').replace(/\/$/, '');
  const markToken  = config?.token  || config?.pat  || '';
  const markCredFlags = [
    markServer && `-b "${markServer}"`,
    markToken  && `-p "${markToken}"`,
  ].filter(Boolean).join(' ');

  const spaceKey = config?.space;
  let parentLookupClient = null;

  async function ensureDefaultParentHeadersForNewPage(rawContent) {
    const hasPageId = /<!--\s*PageId:\s*\d+\s*-->/.test(rawContent);
    if (hasPageId) return rawContent;

    const hasParent = /<!--\s*Parent:\s*.+?\s*-->/.test(rawContent);
    const hasParentPageId = /<!--\s*ParentPageId:\s*\d+\s*-->/.test(rawContent);
    if (hasParent || hasParentPageId) return rawContent;

    const rootPageId = String(config?.root_page || config?.root_page_id || manifest.rootPage || '').trim();
    if (!rootPageId) return rawContent;

    let parentTitle = manifest.pages?.[rootPageId]?.title || null;
    if (!parentTitle) {
      try {
        if (!parentLookupClient) parentLookupClient = getClient(config);
        const parentPage = await parentLookupClient.getPage(rootPageId, 'title');
        parentTitle = parentPage?.title || null;
      } catch {
        // Parent title is optional; ParentPageId is enough to set hierarchy.
      }
    }

    let insertion = `<!-- ParentPageId: ${rootPageId} -->\n`;
    if (parentTitle) insertion += `<!-- Parent: ${parentTitle} -->\n`;

    if (/<!--\s*Space:\s*.+?\s*-->/.test(rawContent)) {
      return rawContent.replace(/(<!--\s*Space:\s*.+?\s*-->\n?)/, `$1${insertion}`);
    }

    // If no Space header exists yet, keep existing auto-header injector path untouched.
    return rawContent;
  }

  let ok = 0, skipped = 0;
  if (cleanOnly) {
    console.log('\n  --clean: skipping push, running orphan cleanup only.\n');
  }
  for (const f of cleanOnly ? [] : files) {
    try {
      let currentFile = f;
      let raw = fs.readFileSync(currentFile, 'utf8');

      // Auto-inject mark headers for new files (no <!-- Space: --> header)
      if (!/<!--\s*Space:\s*/.test(raw)) {
        const { headers, title: injectedTitle } = buildHeadersForNewFile(raw, currentFile, config, manifest);
        // Strip any pre-existing metadata lines to avoid duplication
        const bodyOnly = raw.replace(/<!--\s*(?:Space|Parent|Title):[^\n]*-->\n?/g, '').replace(/^\n+/, '');
        raw = headers + '\n' + bodyOnly;
        fs.writeFileSync(currentFile, raw, 'utf8');
        console.log(`  + ${path.relative(spaceRoot, currentFile)}  (new, headers injected)`);
      }

      // New page safety: if parent is not explicit, default to root_page_id.
      const withDefaultParent = await ensureDefaultParentHeadersForNewPage(raw);
      if (withDefaultParent !== raw) {
        raw = withDefaultParent;
        fs.writeFileSync(currentFile, raw, 'utf8');
      }

      // Skip unchanged tracked files (hash matches manifest)
      const pageIdMatch = raw.match(/<!--\s*PageId:\s*(\d+)\s*-->/);
      const titleMatch  = raw.match(/<!--\s*Title:\s*(.+?)\s*-->/);
      const pageId      = pageIdMatch?.[1];
      const newTitle    = titleMatch?.[1];
      const manifestEntry = pageId ? manifest.pages?.[pageId] : null;
      const oldTitle    = manifestEntry?.title;
      const titleChanged = !!(manifestEntry && newTitle && newTitle !== oldTitle);

      // If only the title changed (or the rename previously failed), rename the local file
      // now regardless of whether we push — so it's always in sync with the Title comment.
      if (titleChanged) {
        const expectedFilename = slugifyTitle(newTitle) + '.md';
        const expectedFilepath = path.join(path.dirname(currentFile), expectedFilename);
        if (expectedFilepath !== currentFile && fs.existsSync(currentFile)) {
          fs.renameSync(currentFile, expectedFilepath);
          const folderRenamed = renameSlugFolder(path.dirname(expectedFilepath), oldTitle, newTitle);
          if (folderRenamed) console.log(`  ↻ ${folderRenamed}`);
          console.log(`  ↻ ${path.basename(currentFile)} → ${expectedFilename}`);
          currentFile = expectedFilepath;
          raw = fs.readFileSync(currentFile, 'utf8');
          if (manifestEntry.localPath) {
            manifestEntry.localPath = path.join(
              path.dirname(manifestEntry.localPath), expectedFilename
            ).replace(/\\/g, '/');
          }
          manifestEntry.title = newTitle;
          writeManifest(spaceRoot, manifest);
        }
      }

      // Skip unchanged files — but always push when title changed (Confluence title must stay in sync)
      if (!forceHash && !titleChanged && manifestEntry?.hash && contentHash(raw) === manifestEntry.hash) {
        skipped++;
        continue;
      }

      // For new pages (no PageId): validate parent exists in Confluence before pushing
      if (!pageId) {
        const fileDir = path.dirname(path.resolve(currentFile));
        const dirName = path.basename(fileDir);
        const parentDirMd = path.join(fileDir, '..', dirName + '.md');
        const isAtSpaceRoot = path.resolve(fileDir) === path.resolve(spaceRoot);
        if (!isAtSpaceRoot && fs.existsSync(parentDirMd)) {
          // Re-read parent from disk — it may have just been pushed and had its PageId written
          const parentContent = fs.readFileSync(parentDirMd, 'utf8');
          if (!/<!--\s*PageId:\s*\d+\s*-->/.test(parentContent)) {
            const parentTitle = parentContent.match(/<!--\s*Title:\s*(.+?)\s*-->/)?.[1]
              || path.basename(parentDirMd, '.md');
            console.error(`  ✗ ${path.relative(spaceRoot, currentFile)}: parent "${parentTitle}" has no PageId yet.`);
            console.error(`    Push parent first: padd confluence push ${path.relative(process.cwd(), parentDirMd)}`);
            continue;
          }
        }
      }

      if (titleChanged && pageId && spaceKey) {
        let renameClient;
        try { renameClient = getClient(config); } catch { /* no credentials available */ }
        if (renameClient) {
          // Check for title conflict first
          const existing = await renameClient.findPageByTitle(spaceKey, newTitle);
          if (existing && String(existing.id) !== String(pageId)) {
            console.error(`  ✗ ${path.basename(f)}: title "${newTitle}" is already taken in space ${spaceKey}. Skipping.`);
            continue;
          }
          // Rename the page on Confluence BEFORE mark runs, so mark finds it by new title
          // instead of creating a new page.
          try {
            const existingPage = await renameClient.getPage(pageId, 'body.storage,version');
            await renameClient.updatePage({
              pageId,
              title: newTitle,
              body: existingPage.body?.storage?.value ?? '',
              version: existingPage.version.number,
            });
            console.log(`  ↻ "${oldTitle}" → "${newTitle}" (renamed on Confluence)`);
          } catch (e) {
            console.error(`  ⚠ Could not pre-rename page: ${e.message} — mark may create a duplicate.`);
          }
        }
      }

      // Prepare content: strip title heading from body, restore Confluence XML
      const titleForStrip = raw.match(/<!--\s*Title:\s*(.+?)\s*-->/)?.[1];
      let bodyForPush = raw;
      if (titleForStrip) {
        // Strip setext heading matching the title
        bodyForPush = bodyForPush.replace(
          new RegExp(`^${titleForStrip.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n=+\\n?`, 'm'),
          ''
        );
        // Strip ATX h1 matching the title
        bodyForPush = bodyForPush.replace(
          new RegExp(`^#\\s+${titleForStrip.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`, 'm'),
          ''
        );
      }
      // Strip PageId header — it's internal to PADD, mark doesn't understand it.
      // For existing pages (with PageId), also strip <!-- Parent: --> so mark never
      // moves a page based on a stale comment. Parent is already set in Confluence.
      // Extract <!--[CONFLUENCE]--> blocks as placeholders so mark receives clean
      // markdown; the real Confluence XML is injected back via API after push.
      const { stripped: _pushStripped, blocks: verbatimBlocks } =
        extractVerbatimBlocks(preprocessMarkdown(convertRelativeMdLinks(bodyForPush, currentFile, spaceRoot)));
      let pushContent = _pushStripped.replace(/<!--\s*PageId:\s*\d+\s*-->\n?/g, '');
      if (pageId) {
        // Existing page — strip Parent to prevent mark from moving it on stale data
        pushContent = pushContent.replace(/<!--\s*Parent:\s*[^\n]*-->\n?/g, '');
      }
      const tmpFile = currentFile.replace(/\.md$/, '._padd_push.md');
      fs.writeFileSync(tmpFile, pushContent, 'utf8');
      try {
        execSync(`mark -f "${tmpFile}" ${markCredFlags}`.trim(), { stdio: verbose ? 'inherit' : 'pipe' });
      } finally {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      }
      ok++;
      console.log(`  ↑ ${path.relative(spaceRoot, currentFile)}`);

      // Remove from staged after successful push
      const relPushed = path.relative(spaceRoot, currentFile).replace(/\\/g, '/');
      if (manifest.staged) {
        manifest.staged = manifest.staged.filter(p => p !== relPushed);
      }

      // Post-push: restore verbatim Confluence macros via API.
      // mark receives placeholders in the markdown; we replace them with the real
      // <ac:...> XML in the live Confluence storage format after mark has pushed.
      if (verbatimBlocks.length > 0 && spaceKey) {
        let fixClient;
        try { fixClient = getClient(config); } catch { /* no credentials */ }
        if (fixClient) {
          try {
            const fixTitle = raw.match(/<!--\s*Title:\s*(.+?)\s*-->/)?.[1] ?? '';
            // Resolve the live PageId — the stored pageId may be stale (e.g. page was
            // deleted from Confluence and mark recreated it under a different id).
            let fixPageId = pageId || '';
            if (fixPageId) {
              try {
                await fixClient.getPage(fixPageId, 'version'); // existence check
              } catch (e) {
                if (e.message?.includes('404')) {
                  // Stored PageId is gone — find the page mark just updated by title
                  const found = await fixClient.findPageByTitle(spaceKey, fixTitle);
                  if (found) {
                    fixPageId = String(found.id);
                    // Self-heal: update file + manifest so future pushes use correct id
                    const healed = fs.readFileSync(currentFile, 'utf8')
                      .replace(/<!--\s*PageId:\s*\d+\s*-->/, `<!-- PageId: ${fixPageId} -->`);
                    fs.writeFileSync(currentFile, healed, 'utf8');
                    if (manifest.pages[pageId]) {
                      manifest.pages[fixPageId] = { ...manifest.pages[pageId] };
                      delete manifest.pages[pageId];
                    }
                    console.log(`  ✎ PageId self-healed: ${pageId} → ${fixPageId}`);
                  } else {
                    fixPageId = '';
                  }
                } else {
                  throw e;
                }
              }
            }
            if (!fixPageId) {
              const found = await fixClient.findPageByTitle(spaceKey, fixTitle);
              if (found) fixPageId = String(found.id);
            }
            if (fixPageId) {
              const livePage = await fixClient.getPage(fixPageId, 'body.storage,version');
              let fixedBody = livePage.body?.storage?.value ?? '';
              let restoredCount = 0;
              for (const { id, xml } of verbatimBlocks) {
                const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                // mark renders `id` (inline code) as <code ...>id</code> in Confluence storage
                // — it may add class attributes, so use <code[^>]*> instead of <code>
                const before = fixedBody;
                fixedBody = fixedBody.replace(new RegExp(`<p>\\s*<code[^>]*>\\s*${esc}\\s*<\\/code>\\s*<\/p>`, 'g'), xml);
                fixedBody = fixedBody.replace(new RegExp(`<code[^>]*>\\s*${esc}\\s*<\\/code>`, 'g'), xml);
                if (fixedBody !== before) {
                  restoredCount++;
                } else {
                  console.warn(`  ⚠ No match found for placeholder: ${id}`);
                }
              }
              // Write body to temp file for inspection (deleted on success)
              const debugFile = currentFile.replace(/\.md$/, '._padd_fixbody.html');
              fs.writeFileSync(debugFile, fixedBody, 'utf8');
              await fixClient.updatePage({
                pageId: fixPageId,
                title: fixTitle,
                body: fixedBody,
                version: livePage.version.number,
              });
              if (fs.existsSync(debugFile)) fs.unlinkSync(debugFile);
              if (restoredCount > 0) console.log(`  ✎ ${restoredCount} Confluence macro(s) restored`);
              if (restoredCount < verbatimBlocks.length) {
                console.warn(`  ⚠ ${verbatimBlocks.length - restoredCount} macro(s) could not be matched — check the page manually.`);
              }
            }
          } catch (e) {
            console.error(`  ⚠ Macro restore failed: ${e.message}`);
            if (e.responseBody) console.error(`    ${e.responseBody}`);
          }
        } else {
          console.warn(`  ⚠ No credentials — ${verbatimBlocks.length} macro(s) not restored. Add token to .confluence.yaml`);
        }
      }

      // Update manifest hash for existing tracked pages so next push skips unchanged files
      if (pageId && manifestEntry) {
        manifestEntry.hash = contentHash(raw);
      }

      // Post-push: if file had no PageId, find the created/adopted page and write PageId back
      if (!pageId && newTitle && spaceKey) {
        let createClient;
        try { createClient = getClient(config); } catch { /* no credentials */ }
        if (createClient) {
          try {
            const found = await createClient.findPageByTitle(spaceKey, newTitle);
            if (found) {
              const newPageId = String(found.id);
              // Fetch full page with ancestors to derive correct local path
              const fullFound = await createClient.getPage(newPageId, 'version,space,ancestors');

              const fileContent = fs.readFileSync(currentFile, 'utf8');
              const withId = fileContent.replace(
                /(<!--\s*Title:[^\n]*\n)/,
                `$1<!-- PageId: ${newPageId} -->\n`
              );

              // For new pages, always write PageId back in place — the user's
              // chosen filename/path is authoritative. Moving based on Confluence
              // ancestors breaks parent detection for sibling files still to push.
              fs.writeFileSync(currentFile, withId, 'utf8');
              const localPath = path.relative(spaceRoot, currentFile).replace(/\\/g, '/');

              manifest.pages[newPageId] = {
                version: fullFound.version?.number ?? 1,
                title: newTitle,
                localPath,
                parentId: getRemoteParentId(fullFound),
                hash: contentHash(withId),
              };
              writeManifest(spaceRoot, manifest);
              console.log(`  ✎ [${newPageId}] PageId written → ${localPath}`);
            }
          } catch { /* non-critical — PageId will be added on next pull */ }
        }
      }
    } catch {
      console.error(`  ✗ Failed: ${f}`);
    }
  }

  // Detect locally deleted tracked files
  const toDelete = Object.entries(manifest.pages).filter(([id, entry]) =>
    entry.localPath && !fs.existsSync(path.join(spaceRoot, entry.localPath))
  );

  if (toDelete.length > 0) {
    console.log(`\n  ${toDelete.length} page(s) deleted locally:\n`);
    let deleteClient;
    try { deleteClient = getClient(config); } catch { /* no credentials */ }
    let acceptAll = forceAll;
    let deletedCount = 0;
    for (const [id, entry] of toDelete) {
      let confirm = acceptAll;
      if (!confirm) {
        const answer = await promptYNA(`    ${entry.localPath}  [y/n/a] `);
        if (answer === 'a') { acceptAll = true; confirm = true; }
        else if (answer === 'y') { confirm = true; }
      }
      if (confirm) {
        try {
          if (deleteClient) await deleteClient.deletePage(id);
          delete manifest.pages[id];
          console.log(`  - ${entry.localPath} → deleted`);
          deletedCount++;
        } catch (e) {
          console.error(`  ✗ Failed to delete [${id}] ${entry.title}: ${e.message}`);
        }
      } else {
        console.log(`  ~ ${entry.localPath} → kept`);
      }
    }
    if (deletedCount === 0) {
      console.log('\n  Nothing deleted. Run `padd confluence pull` to restore local files.');
    }
  }

  writeManifest(spaceRoot, manifest);
  const parts = [ok && `${ok} pushed`, skipped && `${skipped} unchanged`].filter(Boolean);
  if (ok === 0 && skipped > 0 && !explicitTarget && !cleanOnly) {
    console.log(`\n  Everything up to date. ${skipped} staged file(s) unchanged.`);
    console.log(`  Files remain staged — edit them and push again, or use --force to push anyway.\n`);
  } else {
    console.log(`\n✓ ${parts.join(', ') || 'nothing to push'}.\n`);
  }
}

// ─── Sync ─────────────────────────────────────────────────────────────────────

async function runSync(args) {
  const first = args[0] || '';
  const resolvedFirst = path.resolve(first);
  const looksLikePath = first.startsWith('.') || first.startsWith('/') || first.includes(path.sep);
  const isExistingDir = fs.existsSync(resolvedFirst) && fs.statSync(resolvedFirst).isDirectory();

  if (looksLikePath || isExistingDir) {
    // sync <dir> → push only
    console.log('\n📤 Sync (push only)...');
    await runPush(args);
  } else {
    // sync [page-id] [options] → pull (update tracked or specific page) then push
    const opts = parsePullArgs(args);
    const searchDir = opts.rootFolder ? path.resolve(opts.rootFolder) : process.cwd();
    const config = loadConfluenceContext(searchDir);
    const spaceRoot = resolveSpaceRoot(opts.rootFolder, config);

    console.log('\n📥 Sync 1/2: pull...');
    await runPull(args);
    console.log('📤 Sync 2/2: push...');
    await runPush([spaceRoot]);
  }
}

// ─── Arg Parsing ──────────────────────────────────────────────────────────────

function parsePullArgs(args) {
  let spaceKey = null;
  let pageId = null;
  let childDepth = 0;
  let noParents = false;
  let flat = false;
  let rootFolder = null;
  let all = false;
  let force = false;
  let yes = false;
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--all') {
      all = true;
    } else if (arg === '--force' || arg === '-f') {
      force = true;
    } else if (arg === '--yes' || arg === '-y') {
      yes = true;
    } else if (arg === '--children') {
      childDepth = Infinity;
    } else if (arg.startsWith('--children=')) {
      childDepth = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--include-childs') {
      childDepth = Infinity;
    } else if (arg.startsWith('--include-childs=')) {
      childDepth = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--no-parents') {
      noParents = true;
    } else if (arg === '--flat') {
      flat = true;
    } else if (arg === '--rootFolder' || arg === '--root-folder' || arg === '--output' || arg === '-o') {
      rootFolder = args[++i];
    } else if (arg.startsWith('--rootFolder=') || arg.startsWith('--root-folder=') || arg.startsWith('--output=')) {
      rootFolder = arg.split('=').slice(1).join('=');
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  if (positional.length >= 2) {
    spaceKey = positional[0];
    pageId = positional[1];
  } else if (positional.length === 1) {
    const arg = positional[0];
    if (/^\d+$/.test(arg)) {
      pageId = arg;
    } else if (arg.endsWith('.md') && fs.existsSync(path.resolve(arg))) {
      // pull <file.md> → extract PageId from the file
      const fileContent = fs.readFileSync(path.resolve(arg), 'utf8');
      const match = fileContent.match(/<!--\s*PageId:\s*(\d+)\s*-->/);
      if (match) {
        pageId = match[1];
      } else {
        console.error(`\n❌ No <!-- PageId: --> found in ${arg}. Pull by page ID instead.\n`);
        process.exit(1);
      }
    } else {
      spaceKey = arg;
    }
  }

  return { spaceKey, pageId, childDepth, noParents, flat, rootFolder, all, force, yes };
}

// ─── Init ────────────────────────────────────────────────────────────────────

async function runInit(args) {
  let spaceKey = null;
  let server = null;
  let token = null;
  let rootFolder = null;
  let rootPage = null;
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--space' || arg === '-s') {
      spaceKey = args[++i];
    } else if (arg.startsWith('--space=')) {
      spaceKey = arg.split('=').slice(1).join('=');
    } else if (arg === '--server') {
      server = args[++i];
    } else if (arg.startsWith('--server=')) {
      server = arg.split('=').slice(1).join('=');
    } else if (arg === '--token' || arg === '-t') {
      token = args[++i];
    } else if (arg.startsWith('--token=')) {
      token = arg.split('=').slice(1).join('=');
    } else if (arg === '--root-page' || arg === '--root_page') {
      rootPage = args[++i];
    } else if (arg.startsWith('--root-page=') || arg.startsWith('--root_page=')) {
      rootPage = arg.split('=').slice(1).join('=');
    } else if (arg === '--rootFolder' || arg === '--root-folder' || arg === '-o') {
      rootFolder = args[++i];
    } else if (arg.startsWith('--rootFolder=') || arg.startsWith('--root-folder=')) {
      rootFolder = arg.split('=').slice(1).join('=');
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  // Positional: [space-key] [dir]  (like git clone <repo> [dir])
  if (positional[0]) spaceKey = positional[0];
  if (positional[1]) rootFolder = positional[1];

  // Default: create ./SPACE_KEY/ in CWD (like git clone)
  const targetDir = rootFolder
    ? path.resolve(rootFolder)
    : spaceKey
      ? path.join(process.cwd(), spaceKey)
      : process.cwd();

  const ymlPath = path.join(targetDir, '.confluence.yaml');
  if (fs.existsSync(ymlPath)) {
    console.error(`\n❌ .confluence.yaml already exists: ${ymlPath}`);
    console.error(`   Edit it directly or delete it and run init again.\n`);
    process.exit(1);
  }

  // Try to inherit server from PADD auth if not provided (best-effort)
  if (!server) {
    try {
      const creds = getProviderCredentials('confluence');
      if (creds?.base_url) server = creds.base_url;
    } catch { /* auth not available here, that's fine */ }
  }

  fs.mkdirSync(targetDir, { recursive: true });

  const lines = ['# Confluence space config'];
  lines.push(server ? `server: ${server}` : `# server: https://confluence.example.com`);
  if (spaceKey) lines.push(`space: ${spaceKey}`);
  else lines.push(`# space: MY_SPACE_KEY`);
  if (rootPage) lines.push(`root_page: ${rootPage}`);
  else lines.push(`# root_page: <page-id>   # enables: padd confluence pull --all`);
  if (token) lines.push(`token: ${token}`);
  else lines.push(`# token: your-PAT-here   # or use: padd auth refresh confluence`);

  fs.writeFileSync(ymlPath, lines.join('\n') + '\n', 'utf8');

  console.log(`\n✓ ${ymlPath}`);
  if (token) {
    console.log(`\n  ⚠  Token stored in plain text — add .confluence.yaml to .gitignore if needed.`);
  }
  console.log(`\nNext:`);
  console.log(`  cd ${targetDir}`);
  if (rootPage) console.log(`  padd confluence pull --all`);
  else console.log(`  padd confluence pull <page-id>`);
  console.log();
}

// ─── Help ─────────────────────────────────────────────────────────────────────

function showHelp() {
  console.log(`
padd confluence - Confluence sync (git-like)

USAGE
  padd confluence init [<space>] [<folder>] [options]
  padd confluence pull [<space>] <page-id> [options]
  padd confluence add  <file|dir|.>
  padd confluence remove <file|dir|.>
  padd confluence push [<file|dir>]
  padd confluence status
  padd confluence fetch
  padd confluence sync [<space>] <page-id> [options]
  padd confluence sync <directory>

GIT-LIKE WORKFLOW
  # 1. Edit local files
  # 2. Stage changes
  padd confluence add .              # stage all modified + new files
  padd confluence add home.md        # stage a specific file
  # 3. Review
  padd confluence status             # see what's staged, modified, deleted, behind
  # 4. Push staged files
  padd confluence push               # push staged files only
  # 5. Refresh remote version info (no file changes)
  padd confluence fetch              # update remote versions in manifest

PULL / SYNC OPTIONS
  (no args)           Sync tracked pages: download changed, delete removed
  --all               Full space sync: discover + download new/changed, delete removed
                      (requires root_page in confluence.yml — shows preview before downloading)
  --yes / -y          Skip confirmation prompt (for scripts)
  --force             Overwrite locally modified files without warning
  --children          Download all descendant pages
  --children=N        Download N levels of children
  --no-parents        Skip ancestors; place page directly at space root
  --flat              All files in space root (no subfolders)
  --rootFolder <dir>  Explicit space root path

DEFAULTS FROM CONFIG (optional)
  In confluence.pull (inside .padd.yaml):
  - no_parents_default: true|false
  - auto_all_on_empty_manifest: true|false
  - bootstrap_page_id: <page-id>

PUSH OPTIONS
  (no args)           Push staged files only (use "add" to stage first)
  <file|dir>          Push explicit target (bypasses staging)
  --force             Push staged files ignoring unchanged hash (re-push even if up to date)
  --clean             Skip push; only delete Confluence pages missing locally
  --verbose / -v      Show mark output

SPACE ROOT
  - Legacy: the directory where .confluence.yaml lives IS the space root.
  - .padd.yaml fallback: current working directory is used as the space root.
  Files are written relative to the resolved root.

CONFLUENCE CONFIG  (searched upward; child overrides parent)
  Legacy .confluence.yaml:
  server: https://confluence.uhub.biz
  token:  your-PAT          # optional if using padd auth
  space:  WUNARGUA

  Or .padd.yaml (section confluence):
  confluence:
    base_url: https://confluence.uhub.biz
    access_token: your-PAT
    space: WUNARGUA
    root_page_id: 123456

INIT OPTIONS
  <space>               Space key — also becomes the folder name
  [dir]                 Override folder name/path (default: ./<space>/)
  --root-page <id>      Home page ID — enables: padd confluence pull --all
  --server <url>        Confluence base URL (auto-detected from padd auth)
  --token  <pat>        Personal Access Token (plain text — use carefully)

EXAMPLES
  # Setup (like git clone) then pull entire space
  padd confluence init WUNARGUA --root-page 928781002
  cd WUNARGUA && padd confluence pull --all

  # Daily workflow
  cd WUNARGUA
  padd confluence pull               # get remote changes
  # ...edit files...
  padd confluence add .              # stage all changes
  padd confluence status             # review
  padd confluence push               # push staged

  # Push a specific file immediately (bypasses staging)
  padd confluence push home.md

NOTES
  - pull: uses confluence.yml or padd auth refresh confluence
  - push: requires mark (brew tap kovetskiy/mark && brew install mark)
  - Each .md includes <!-- PageId --> for unambiguous updates on push
`);
}

// ─── Add (staging) ────────────────────────────────────────────────────────────

// ─── Remove (unstage) ─────────────────────────────────────────────────────────

async function runRemove(args) {
  const searchDir = process.cwd();
  const config = loadConfluenceContext(searchDir);
  const spaceRoot = config?._spaceRoot || searchDir;
  const manifest = readManifest(spaceRoot);

  const targets = args.filter(a => !a.startsWith('-'));
  if (targets.length === 0) {
    console.error('\n❌ Usage: padd confluence remove <file|dir|.>\n');
    process.exit(1);
  }

  const removed = [];
  for (const target of targets) {
    const targetPath = path.resolve(target);
    let relPaths = [];
    if (!fs.existsSync(targetPath)) {
      // Allow removing by relative path even if file is gone
      const rel = path.relative(spaceRoot, targetPath).replace(/\\/g, '/');
      relPaths = [rel];
    } else if (fs.statSync(targetPath).isDirectory()) {
      relPaths = findMdFiles(targetPath).map(f => path.relative(spaceRoot, f).replace(/\\/g, '/'));
    } else {
      relPaths = [path.relative(spaceRoot, targetPath).replace(/\\/g, '/')];
    }

    for (const rel of relPaths) {
      if (rel.startsWith('..')) continue;
      if (manifest.staged.includes(rel)) {
        manifest.staged = manifest.staged.filter(p => p !== rel);
        removed.push(rel);
      }
    }
  }

  writeManifest(spaceRoot, manifest);
  if (removed.length > 0) {
    console.log(`\n  Unstaged ${removed.length} file(s):\n`);
    for (const f of removed) console.log(`  - ${f}`);
    console.log();
  } else {
    console.log('\n  Nothing to unstage.\n');
  }
}

// ─── Add (staging) ────────────────────────────────────────────────────────────

async function runAdd(args) {
  const searchDir = process.cwd();
  const config = loadConfluenceContext(searchDir);
  const spaceRoot = config?._spaceRoot || searchDir;
  const manifest = readManifest(spaceRoot);

  const targets = args.filter(a => !a.startsWith('-'));
  if (targets.length === 0) {
    console.error('\n❌ Usage: padd confluence add <file|dir|.>\n');
    process.exit(1);
  }

  const added = [];
  for (const target of targets) {
    const targetPath = path.resolve(target);
    if (!fs.existsSync(targetPath)) {
      console.error(`  ✗ Not found: ${target}`);
      continue;
    }
    const files = fs.statSync(targetPath).isDirectory()
      ? findMdFiles(targetPath)
      : [targetPath];

    for (const f of files) {
      const relPath = path.relative(spaceRoot, f).replace(/\\/g, '/');
      if (relPath.startsWith('..')) continue; // outside space root
      if (!manifest.staged.includes(relPath)) {
        manifest.staged.push(relPath);
        added.push(relPath);
      }
    }
  }

  writeManifest(spaceRoot, manifest);
  if (added.length > 0) {
    console.log(`\n  Staged ${added.length} file(s):\n`);
    for (const f of added) console.log(`  + ${f}`);
    console.log();
  } else {
    console.log('\n  Nothing new to stage.\n');
  }
}

// ─── Status ───────────────────────────────────────────────────────────────────

async function runStatus(args) {
  const searchDir = process.cwd();
  const config = loadConfluenceContext(searchDir);
  const spaceRoot = config?._spaceRoot || searchDir;

  if (!fs.existsSync(spaceRoot)) {
    console.error('\n❌ No space root found. Run: padd confluence pull <page-id>\n');
    process.exit(1);
  }

  const manifest = readManifest(spaceRoot);
  const staged   = new Set(manifest.staged || []);
  const remote   = manifest.remote || {};

  // Use Sets to avoid duplicates from manifest entries that share the same localPath
  const stagedSet   = new Set();
  const modifiedSet = new Set();
  const deletedSet  = new Set();
  const behind      = [];

  const trackedPaths = new Set();
  for (const [id, entry] of Object.entries(manifest.pages)) {
    if (!entry.localPath) continue;
    // Skip duplicate localPath entries (can happen after Confluence duplicate pages)
    if (trackedPaths.has(entry.localPath)) continue;
    trackedPaths.add(entry.localPath);
    const filepath = path.join(spaceRoot, entry.localPath);

    if (!fs.existsSync(filepath)) {
      deletedSet.add(entry.localPath);
      continue;
    }

    const currentHash = contentHash(fs.readFileSync(filepath, 'utf8'));
    const isDirty = entry.hash && currentHash !== entry.hash;

    if (staged.has(entry.localPath)) {
      stagedSet.add(entry.localPath);
    } else if (isDirty) {
      modifiedSet.add(entry.localPath);
    }

    if (remote[id] && remote[id] > (entry.version ?? 0)) {
      behind.push({ path: entry.localPath, local: entry.version ?? 0, remote: remote[id] });
    }
  }

  const newFilesSet = new Set();
  // Untracked local files (no PageId / not in manifest)
  for (const f of findMdFiles(spaceRoot)) {
    const relPath = path.relative(spaceRoot, f).replace(/\\/g, '/');
    if (trackedPaths.has(relPath)) continue;
    const content = fs.readFileSync(f, 'utf8');
    if (/<!--\s*PageId:\s*\d+\s*-->/.test(content)) continue; // has PageId but not in manifest
    staged.has(relPath) ? stagedSet.add(relPath) : newFilesSet.add(relPath);
  }

  const stagedList   = [...stagedSet];
  const modified     = [...modifiedSet];
  const newFiles     = [...newFilesSet];
  const deleted      = [...deletedSet];

  const hasAnything = stagedList.length || modified.length || newFiles.length || deleted.length || behind.length;
  if (!hasAnything) {
    console.log('\nNothing to push. Working tree clean.\n');
    return;
  }

  const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', C = '\x1b[36m', Z = '\x1b[0m';

  if (stagedList.length) {
    console.log('\nChanges staged for push:\n');
    for (const f of stagedList) console.log(`  ${G}S  ${f}${Z}`);
    console.log(`\n  (use "padd confluence push" to push)`);
  }
  if (modified.length) {
    console.log('\nChanges not staged:\n');
    for (const f of modified) console.log(`  ${Y}M  ${f}${Z}`);
    console.log(`\n  (use "padd confluence add <file>" to stage)`);
  }
  if (newFiles.length) {
    console.log('\nNew files not yet pushed:\n');
    for (const f of newFiles) console.log(`  ${Y}?  ${f}${Z}`);
    console.log(`\n  (use "padd confluence add <file>" to stage)`);
  }
  if (deleted.length) {
    console.log('\nDeleted locally:\n');
    for (const f of deleted) console.log(`  ${R}D  ${f}${Z}`);
    console.log(`\n  (use "padd confluence push --clean" to remove from Confluence)`);
  }
  if (behind.length) {
    console.log('\nBehind remote (run "padd confluence pull"):\n');
    for (const b of behind) console.log(`  ${C}↓  ${b.path}  [local v${b.local} / remote v${b.remote}]${Z}`);
  }
  console.log();
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

async function runFetch(args) {
  const searchDir = process.cwd();
  const config = loadConfluenceContext(searchDir);
  if (!config) {
    console.error('\n❌ No Confluence config found (.confluence.yaml or .padd.yaml).\n');
    process.exit(1);
  }
  const spaceRoot = config._spaceRoot || searchDir;
  const manifest = readManifest(spaceRoot);

  let client;
  try { client = getClient(config); } catch (e) {
    console.error(`\n❌ No credentials: ${e.message}\n`);
    process.exit(1);
  }

  const pageIds = Object.keys(manifest.pages);
  if (pageIds.length === 0) {
    console.error('\n❌ Nothing tracked. Run: padd confluence pull <page-id>\n');
    process.exit(1);
  }

  console.log(`\n  Fetching ${pageIds.length} page version(s)...\n`);

  let behind = 0, upToDate = 0, gone = 0;
  for (const id of pageIds) {
    try {
      const page = await client.getPage(id, 'version');
      const remoteVer  = page.version?.number ?? 0;
      const localVer   = manifest.pages[id].version ?? 0;
      manifest.remote[id] = remoteVer;
      if (remoteVer > localVer) {
        console.log(`  ↓ ${manifest.pages[id].localPath}  [local v${localVer} → remote v${remoteVer}]`);
        behind++;
      } else {
        upToDate++;
      }
    } catch (e) {
      if (e.message?.includes('404')) {
        console.log(`  ✗ ${manifest.pages[id].localPath}  (deleted on remote)`);
        manifest.remote[id] = 0;
        gone++;
      }
    }
  }

  writeManifest(spaceRoot, manifest);
  const parts = [
    behind   && `${behind} behind`,
    upToDate && `${upToDate} up to date`,
    gone     && `${gone} gone`,
  ].filter(Boolean);
  console.log(`\n✓ ${parts.join(', ')}. Run "padd confluence status" to review.\n`);
}

// ─── Router ───────────────────────────────────────────────────────────────────

export async function run(args) {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    showHelp();
    process.exit(0);
  }

  switch (subcommand) {
    case 'init':    await runInit(subArgs);    break;
    case 'pull':    await runPull(subArgs);    break;
    case 'push':    await runPush(subArgs);    break;
    case 'sync':    await runSync(subArgs);    break;
    case 'add':     await runAdd(subArgs);     break;
    case 'remove':  await runRemove(subArgs);  break;
    case 'status':  await runStatus(subArgs);  break;
    case 'fetch':   await runFetch(subArgs);   break;
    default:
      console.error(`\n❌ Unknown subcommand: ${subcommand}`);
      console.error(`   Run: padd confluence --help\n`);
      process.exit(1);
  }
}
