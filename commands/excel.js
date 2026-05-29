#!/usr/bin/env node

/**
 * padd excel - SharePoint Excel sync (pull/push)
 *
 * Config-first workflow:
 * - Uses local config discovered from current directory upward
 * - Encourages config next to CSV files (for example schedule.csv)
 *
 * Supported config files (first found upward):
 *   - .padd.yaml / .padd.yml
 *   - padd.yaml / padd.yml
 *   - config.talk.json (fallback for talk domain compatibility)
 */

import path from 'path';
import fs from 'fs';
import { loadCoreConfig, getSharePointAccessToken } from '../lib/core-config.js';
import {
  resolveExcelSyncConfig,
  pullExcelSheets,
  pushExcelSheets,
  DEFAULT_EXCEL_CONFIG_FILENAMES,
} from '../lib/sharepoint-excel-sync.js';

function showHelp() {
  console.log(`
padd excel - SharePoint Excel sync

USAGE
  padd excel <init|clone|pull|push> [options]

OPTIONS
  --config <path>      Explicit config file path
  --file <path>        CSV file path for file-by-file mode (optional)
  --sharing-url <url>  SharePoint sharing URL (pull, optional push override)
  # Pull can bootstrap one sheet to one local csv file (first time)
  padd excel pull schedule.csv --sheet Schedule --sharing-url "https://..."
  padd excel pull --sheet Schedule --sharing-url "https://..."   # defaults to schedule.csv

  # Clone is still available as explicit bootstrap alias
  padd excel clone schedule.csv --sheet Schedule --sharing-url "https://..."
  padd excel clone --sheet Schedule --sharing-url "https://..."  # defaults to schedule.csv
  --force              Overwrite existing .padd.yaml (init only)
  # Pull updates from remote using CSV metadata
  padd excel pull schedule.csv

  # Push local changes using CSV metadata

  padd excel push schedule.csv
CONFIG STRATEGY
  # Clone/pull/push without sharing url using ids
  padd excel clone schedule.csv --sheet Schedule --drive-id "b!..." --item-id "01..."
  padd excel pull schedule.csv --drive-id "b!..." --item-id "01..."
  padd excel push schedule.csv --drive-id "b!..." --item-id "01..."

  # Override metadata on demand
  padd excel pull schedule.csv --sheet Schedule --sharing-url "https://..."
  padd excel push schedule.csv --sheet Schedule --sharing-url "https://..."

EXAMPLES
  padd excel clone --profile feedback
  padd excel init

  # Pull one sheet to one file (file-by-file mode)
  padd excel pull --file schedule.csv --sheet Schedule --sharing-url "https://..."
  padd excel pull --sheet Schedule --sharing-url "https://..."   # defaults to schedule.csv
  padd excel pull schedule.csv --sheet Schedule --sharing-url "https://..."

  # Push one file back using metadata comments from the csv
  padd excel push --file schedule.csv
  padd excel push schedule.csv

  # Pull/push without sharing url using ids
  padd excel pull --file schedule.csv --sheet Schedule --drive-id "b!..." --item-id "01..."
  padd excel push --file schedule.csv --drive-id "b!..." --item-id "01..."

  # Push one file overriding metadata values
  padd excel push --file schedule.csv --sheet Schedule --sharing-url "https://..."

  # Legacy config mode (still supported)
  padd excel pull --profile feedback
`);
}

function parseArgs(args) {
  const options = {
    configPath: null,
    filePath: null,
    sharingUrl: null,
    driveId: null,
    itemId: null,
    profile: 'schedule',
    sheets: [],
    force: false,
  };

  const positional = [];

  const isLikelyUrl = (value) => {
    try {
      const parsed = new URL(String(value || ''));
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    if (arg === '--force') {
      options.force = true;
      continue;
    }

    if (arg === '--config') {
      options.configPath = args[i + 1];
      i++;
      continue;
    }

    if (arg === '--file') {
      options.filePath = args[i + 1];
      i++;
      continue;
    }

    if (arg === '--sharing-url') {
      options.sharingUrl = args[i + 1];
      i++;
      continue;
    }

    if (arg === '--drive-id') {
      options.driveId = args[i + 1];
      i++;
      continue;
    }

    if (arg === '--item-id') {
      options.itemId = args[i + 1];
      i++;
      continue;
    }

    if (arg === '--profile') {
      options.profile = args[i + 1] || 'schedule';
      i++;
      continue;
    }

    if (arg === '--sheet') {
      const sheetName = args[i + 1];
      if (!sheetName) {
        throw new Error('--sheet requires a value');
      }
      options.sheets.push(sheetName);
      i++;
      continue;
    }

    if (!arg.startsWith('--')) {
      positional.push(arg);
    }
  }

  options.command = positional[0];
  if (positional[1]) {
    if (!options.sharingUrl && isLikelyUrl(positional[1])) {
      options.sharingUrl = positional[1];
    } else if (!options.filePath) {
      options.filePath = positional[1];
    }
  }

  if (options.filePath && !options.sharingUrl && isLikelyUrl(options.filePath)) {
    options.sharingUrl = options.filePath;
    options.filePath = null;
  }
  return options;
}

function defaultCsvPathFromSheet(sheetName) {
  const normalized = String(sheetName || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!normalized) {
    throw new Error('Cannot infer csv filename from empty sheet name');
  }

  return `${normalized}.csv`;
}

function resolveFilePath(options, { allowInferFromSheet = false } = {}) {
  if (options.filePath) {
    return options.filePath;
  }

  if (allowInferFromSheet && options.sheets[0]) {
    return defaultCsvPathFromSheet(options.sheets[0]);
  }

  return null;
}

function buildInitTemplate() {
  return `sharepoint:
  # Manual token only (no auto-refresh in excel sync)
  access_token: "REPLACE_WITH_MS_GRAPH_ACCESS_TOKEN"
`;
}

async function excelInit(options) {
  const targetPath = path.join(process.cwd(), '.padd.yaml');

  if (fs.existsSync(targetPath) && !options.force) {
    throw new Error(
      `Config already exists at ${targetPath}. ` +
        `Use --force to overwrite.`
    );
  }

  fs.writeFileSync(targetPath, buildInitTemplate(), 'utf8');

  console.log('\n✅ Created .padd.yaml\n');
  console.log(`Path: ${targetPath}`);
  console.log('Next steps:');
  console.log('  1. Set sharepoint.access_token');
  console.log('  2. Pull: padd excel pull --file <csv> --sheet <name> --sharing-url <url>');
  console.log('  3. Push: padd excel push --file <csv>\n');
}

function getAccessToken(options) {
  const { configPath, config } = loadCoreConfig({
    startDir: process.cwd(),
    configPath: options.configPath || null,
    required: true,
  });

  const token = getSharePointAccessToken(config, {
    required: true,
    configPath: configPath || 'core config',
  });

  return { token, configPath, config };
}

function inferDefaultSheetNameFromFile(filePath) {
  const base = path.basename(String(filePath || '')).toLowerCase();
  if (base === 'schedule.csv') return 'Schedule';
  if (/^talks(?:_\d{4})?\.csv$/.test(base)) return 'Schedule';
  return null;
}

function getTalkExcelDefaults(config, filePath) {
  const talk = config?.talk || {};
  const sharingUrl = String(talk.excel_sharing_url || '').trim();
  const configuredSheet = String(talk.excel_sheet_name || '').trim();
  const inferredSheet = inferDefaultSheetNameFromFile(filePath);

  return {
    sharingUrl: sharingUrl || null,
    sheetName: configuredSheet || inferredSheet || null,
  };
}

function readCsvCommentMetadata(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const meta = {};

  for (const line of content.split(/\r?\n/)) {
    const simple = line.match(/^\s*#\s*(SharingUrl|BrowserURL|Workbook|Sheet|DriveId|ItemId)\s*:\s*(.*)$/i);
    if (simple) {
      const key = simple[1].toLowerCase();
      const value = simple[2].trim();
      if (key === 'sharingurl') meta.sharing_url = value;
      if (key === 'browserurl') meta.browser_url = value;
      if (key === 'workbook') meta.workbook_name = value;
      if (key === 'sheet') meta.sheet_name = value;
      if (key === 'driveid') meta.drive_id = value;
      if (key === 'itemid') meta.item_id = value;
      continue;
    }

    const match = line.match(/^\s*#\s*padd\.excel\.([a-z0-9_]+)=(.*)$/i);
    if (!match) continue;
    meta[match[1]] = match[2].trim();
  }

  return meta;
}

function countDataRowsFromCsvContent(content) {
  if (!content) return 0;

  const lines = content.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  // Keep parity with existing output semantics (includes header row when present).
  return lines.length;
}

function formatRowDelta(previousRows, currentRows) {
  if (previousRows === null || previousRows === undefined) return '';
  const delta = currentRows - previousRows;
  if (delta === 0) return ', ±0';
  return delta > 0 ? `, +${delta}` : `, ${delta}`;
}

function printPullSummary(resultRows, filePath, previousContent) {
  const rel = path.relative(process.cwd(), filePath) || filePath;
  const currentRows = resultRows;

  if (previousContent === null) {
    console.log(`✓ created ${rel} (${currentRows} rows)`);
    return;
  }

  const newContent = fs.readFileSync(filePath, 'utf8');
  const previousRows = countDataRowsFromCsvContent(previousContent);
  const unchanged = previousContent === newContent;

  if (unchanged) {
    console.log(`✓ up to date ${rel} (${currentRows} rows)`);
    return;
  }

  console.log(`✓ updated ${rel} (${currentRows} rows${formatRowDelta(previousRows, currentRows)})`);
}

function printPushSummary(resultRows, filePath) {
  const rel = path.relative(process.cwd(), filePath) || filePath;
  console.log(`✓ pushed ${rel} (${resultRows} rows)`);
}

function filterSheets(configSheets, selectedSheets) {
  if (!selectedSheets || selectedSheets.length === 0) {
    return configSheets;
  }

  const wanted = new Set(selectedSheets.map((s) => s.toLowerCase()));
  const filtered = configSheets.filter((sheet) => wanted.has(sheet.name.toLowerCase()));

  if (filtered.length === 0) {
    throw new Error(
      `None of the selected sheets were found.\n` +
        `Selected: ${selectedSheets.join(', ')}\n` +
        `Available: ${configSheets.map((s) => s.name).join(', ')}`
    );
  }

  return filtered;
}

async function excelPull(options) {
  const { token, config } = getAccessToken(options);

  const optionsWithDefaultSheet = options.sheets[0]
    ? options
    : { ...options, sheets: ['Sheet1'] };

  const shouldInferFileFromSheet = Boolean(options.sharingUrl || (options.driveId && options.itemId));
  const filePath = resolveFilePath(optionsWithDefaultSheet, { allowInferFromSheet: shouldInferFileFromSheet });
  if (filePath) {
    const sourceFile = path.resolve(process.cwd(), filePath);
    const fileExists = fs.existsSync(sourceFile);
    const previousContent = fileExists ? fs.readFileSync(sourceFile, 'utf8') : null;

    const metadata = fileExists ? readCsvCommentMetadata(sourceFile) : {};
    const defaults = getTalkExcelDefaults(config, sourceFile);
    const sharingUrl = options.sharingUrl || metadata.sharing_url || defaults.sharingUrl;
    const driveId = options.driveId || metadata.drive_id;
    const itemId = options.itemId || metadata.item_id;
    const sheetName = options.sheets[0] || metadata.sheet_name || defaults.sheetName || 'Sheet1';

    if (!sharingUrl && !(driveId && itemId)) {
      throw new Error(
        fileExists
          ? 'Pull requires workbook target. Add DriveId/ItemId comments, use --drive-id/--item-id, pass --sharing-url, or set talk.excel_sharing_url in .padd.yaml.'
          : 'Pull requires workbook target for first download. Use --sharing-url (or --drive-id + --item-id).'
      );
    }

    const result = await pullExcelSheets({
      accessToken: token,
      sharingUrl,
      driveId,
      itemId,
      sheets: [{ name: sheetName, filePath: sourceFile }],
    });

    const first = result.results[0];

    printPullSummary(first.rows, sourceFile, previousContent);
    return;
  }

  const syncConfig = resolveExcelSyncConfig({
    startDir: process.cwd(),
    configPath: options.configPath,
    profile: options.profile,
  });

  const sheets = filterSheets(syncConfig.sheets, options.sheets);
  const accessToken = token;
  const previousContentByFile = new Map(
    sheets.map((sheet) => {
      const previous = fs.existsSync(sheet.filePath) ? fs.readFileSync(sheet.filePath, 'utf8') : null;
      return [sheet.filePath, previous];
    })
  );

  const result = await pullExcelSheets({
    accessToken,
    sharingUrl: syncConfig.sharingUrl,
    sheets,
  });

  for (const item of result.results) {
    printPullSummary(item.rows, item.filePath, previousContentByFile.get(item.filePath) ?? null);
  }
}

async function excelPush(options) {
  const { token } = getAccessToken(options);

  const filePath = resolveFilePath(options, { allowInferFromSheet: false });
  if (filePath || options.sharingUrl || (options.driveId && options.itemId) || options.sheets.length > 0) {
    const inferredFile = filePath;
    if (!inferredFile) {
      throw new Error('Push requires a csv file. Use: padd excel push <csv-filename>');
    }

    const sourceFile = path.resolve(process.cwd(), inferredFile);
    if (!fs.existsSync(sourceFile)) {
      throw new Error(`File not found: ${sourceFile}`);
    }

    const metadata = readCsvCommentMetadata(sourceFile);
    const sharingUrl = options.sharingUrl || metadata.sharing_url;
    const driveId = options.driveId || metadata.drive_id;
    const itemId = options.itemId || metadata.item_id;
    const sheetName = options.sheets[0] || metadata.sheet_name;

    if (!sharingUrl && !(driveId && itemId)) {
      throw new Error('Push file mode requires workbook target. Add DriveId/ItemId comments or use --drive-id/--item-id (sharing-url is fallback).');
    }
    if (!sheetName) {
      throw new Error('Push file mode requires sheet name. Add comment Sheet: ... or use --sheet');
    }

    const result = await pushExcelSheets({
      accessToken: token,
      sharingUrl,
      driveId,
      itemId,
      sheets: [{ name: sheetName, filePath: sourceFile }],
    });

    const first = result.results[0];

    printPushSummary(first.rows, sourceFile);
    return;
  }

  const config = resolveExcelSyncConfig({
    startDir: process.cwd(),
    configPath: options.configPath,
    profile: options.profile,
  });

  const sheets = filterSheets(config.sheets, options.sheets);
  const accessToken = token;

  const result = await pushExcelSheets({
    accessToken,
    sharingUrl: config.sharingUrl,
    sheets,
  });

  for (const item of result.results) {
    printPushSummary(item.rows, item.filePath);
  }
}

async function excelClone(options) {
  const { token } = getAccessToken(options);

  const sheetName = options.sheets[0] || 'Sheet1';
  const sharingUrl = options.sharingUrl;
  const driveId = options.driveId;
  const itemId = options.itemId;

  if (!sharingUrl && !(driveId && itemId)) {
    throw new Error('Clone requires --sharing-url <url> or --drive-id + --item-id');
  }

  const optionsWithDefaultSheet = options.sheets[0]
    ? options
    : { ...options, sheets: [sheetName] };

  const filePath = resolveFilePath(optionsWithDefaultSheet, { allowInferFromSheet: true });
  const targetFile = path.resolve(process.cwd(), filePath);

  const result = await pullExcelSheets({
    accessToken: token,
    sharingUrl,
    driveId,
    itemId,
    sheets: [{ name: sheetName, filePath: targetFile }],
  });

  const rel = path.relative(process.cwd(), targetFile) || targetFile;
  const first = result.results[0];

  console.log('\n🧬 SharePoint Excel Clone\n');
  console.log(`✅ Workbook: ${result.driveItemName}`);
  console.log(`   • ${sheetName} -> ${rel} (${first.rows} rows)\n`);
}

export async function run(args) {
  const options = parseArgs(args);

  if (options.help || !options.command) {
    showHelp();
    process.exit(0);
  }

  if (options.command !== 'init' && options.command !== 'clone' && options.command !== 'pull' && options.command !== 'push') {
    console.error(`\n❌ Unknown excel command: ${options.command}`);
    console.error('   Run: padd excel --help\n');
    process.exit(1);
  }

  if (options.command === 'init') {
    await excelInit(options);
    process.exit(0);
  }

  if (options.command === 'clone') {
    await excelClone(options);
    process.exit(0);
  }

  if (options.command === 'pull') {
    await excelPull(options);
    process.exit(0);
  }

  if (options.command === 'push') {
    await excelPush(options);
    process.exit(0);
  }
}

function normalizeExcelErrorMessage(message) {
  const raw = String(message || 'Unknown error');

  if (/Could not obtain a WAC access token/i.test(raw)) {
    return [
      `${raw}`,
      '',
      'Likely cause: SharingUrl points to a web viewer URL (for example /_layouts/15/Doc.aspx...) instead of a real file share link.',
      'Use a direct Share link for the workbook (preferably :x:/r/... or :x:/s/...) or use --drive-id/--item-id.',
      '',
      'Quick fix:',
      '  1. In SharePoint, open the Excel file -> Share -> Copy link.',
      '  2. Replace the CSV comment `# SharingUrl: ...` with that link.',
      '  3. Run: padd excel pull talks_2026.csv',
    ].join('\n');
  }

  return raw;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2)).catch((err) => {
    console.error(`\n❌ Error: ${normalizeExcelErrorMessage(err.message)}\n`);
    process.exit(1);
  });
}
