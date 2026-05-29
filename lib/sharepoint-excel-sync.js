/**
 * sharepoint-excel-sync.js
 *
 * Generic SharePoint Excel sync helpers (pull/push) for CSV workflows.
 *
 * Design goals:
 * - Pull worksheet used ranges to local CSV files
 * - Push local CSV files back to worksheets
 * - Keep config close to data (same folder as CSV) when desired
 * - Remain backward compatible with talk domain config.talk.json
 */

import fs from 'fs';
import path from 'path';
import { SharePointClient } from './sharepoint-client.js';
import { findConfigPath, loadConfigFile } from './config-loader.js';
import { arrayToCsv, csvToArray } from './csv-utils.js';
import { loadCoreConfig, loadCoreConfigFile, getSharePointAccessToken } from './core-config.js';

export const DEFAULT_EXCEL_CONFIG_FILENAMES = [
  '.padd.yaml',
  '.padd.yml',
  'padd.yaml',
  'padd.yml',
  'config.talk.json',
];

const CSV_COMMENT_PREFIX = '#';

function sharingUrlToToken(sharingUrl) {
  const base64Value = Buffer.from(sharingUrl)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\//g, '_')
    .replace(/\+/g, '-');
  return `u!${base64Value}`;
}

function parseSharePointRFileLink(sharingUrl) {
  try {
    const parsed = new URL(sharingUrl);
    const parts = parsed.pathname.split('/').filter(Boolean);

    // Expected pattern: /:x:/r/sites/<site>/.../file.xlsx
    if (parts.length < 6 || parts[0] !== ':x:' || parts[1] !== 'r') {
      return null;
    }

    const scope = parts[2];
    const siteName = parts[3];
    if (!siteName || (scope !== 'sites' && scope !== 'teams')) {
      return null;
    }

    const sitePath = `/${scope}/${siteName}`;
    const drivePath = decodeURIComponent(parts.slice(4).join('/'));
    if (!drivePath) return null;

    return {
      host: parsed.host,
      sitePath,
      drivePath,
    };
  } catch {
    return null;
  }
}

function parseSharePointBrowserExcelLink(sharingUrl) {
  try {
    const parsed = new URL(sharingUrl);
    const parts = parsed.pathname.split('/').filter(Boolean);

    // Expected pattern: /:x:/r/sites/<site>/_layouts/15/Doc.aspx
    if (parts.length < 7 || parts[0] !== ':x:' || parts[1] !== 'r') {
      return null;
    }

    const scope = parts[2];
    const siteName = parts[3];
    if (!siteName || (scope !== 'sites' && scope !== 'teams')) {
      return null;
    }

    const isDocViewer = parts[4] === '_layouts' && parts[5] === '15' && parts[6].toLowerCase() === 'doc.aspx';
    if (!isDocViewer) {
      return null;
    }

    const sitePath = `/${scope}/${siteName}`;
    const fileName = decodeURIComponent(parsed.searchParams.get('file') || '').trim();
    const sourceDocRaw = decodeURIComponent(parsed.searchParams.get('sourcedoc') || '').trim();
    const sourceDocGuid = sourceDocRaw.replace(/[{}]/g, '').toLowerCase();

    return {
      host: parsed.host,
      sitePath,
      fileName,
      sourceDocGuid: sourceDocGuid || null,
    };
  } catch {
    return null;
  }
}

async function resolveDriveItemFromBrowserExcelUrl(client, parsedBrowserLink) {
  const site = await client.request(`/sites/${parsedBrowserLink.host}:${parsedBrowserLink.sitePath}`);
  if (!site?.id) {
    throw new Error('Could not resolve site from browser URL.');
  }

  const queryName = parsedBrowserLink.fileName || '.xlsx';
  const search = await client.request(
    `/sites/${site.id}/drive/root/search(q='${encodeURIComponent(queryName)}')`
  );

  const candidates = Array.isArray(search?.value)
    ? search.value.filter((item) => item?.file)
    : [];

  if (candidates.length === 0) {
    throw new Error('Could not resolve workbook from browser URL (no matching file found).');
  }

  if (parsedBrowserLink.sourceDocGuid) {
    const matchedByGuid = candidates.find((item) => {
      const listItemGuid = String(item?.sharepointIds?.listItemUniqueId || '').replace(/[{}]/g, '').toLowerCase();
      return listItemGuid && listItemGuid === parsedBrowserLink.sourceDocGuid;
    });

    if (matchedByGuid) {
      return matchedByGuid;
    }
  }

  if (parsedBrowserLink.fileName) {
    const exactName = candidates.find((item) => String(item?.name || '').trim() === parsedBrowserLink.fileName);
    if (exactName) {
      return exactName;
    }
  }

  if (candidates.length === 1) {
    return candidates[0];
  }

  throw new Error('Could not uniquely resolve workbook from browser URL. Use a direct Share link or drive-id/item-id.');
}

function colIndexToLetter(colIndex) {
  let n = colIndex + 1;
  let result = '';

  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }

  return result;
}

function buildA1Range(rows, cols) {
  if (rows < 1 || cols < 1) {
    throw new Error('Cannot build range for empty dataset');
  }

  return `A1:${colIndexToLetter(cols - 1)}${rows}`;
}

function parseYamlSheetMapObject(sheetsObject, defaultsByKey = {}) {
  return Object.entries(sheetsObject).map(([key, value]) => {
    if (typeof value === 'string') {
      return {
        key,
        name: key,
        localFile: value,
      };
    }

    const normalized = {
      key,
      name: value?.name || key,
      localFile: value?.localFile || value?.file || defaultsByKey[key] || `${key}.csv`,
    };

    return normalized;
  });
}

function parseLegacyTalkSheetMap(sheetsObject, defaultsByKey = {}) {
  return Object.entries(sheetsObject).map(([key, sheetName]) => ({
    key,
    name: sheetName,
    localFile: defaultsByKey[key] || `${key}.csv`,
  }));
}

function getExcelProfileConfig(excelSection, profile) {
  if (!excelSection || typeof excelSection !== 'object') {
    return null;
  }

  if (excelSection[profile] && typeof excelSection[profile] === 'object') {
    return excelSection[profile];
  }

  return excelSection;
}

function buildCsvComments(metadata = {}) {
  const ordered = [
    ['BrowserURL', metadata.browser_url],
    ['Workbook', metadata.workbook_name],
    ['Sheet', metadata.sheet_name],
    ['DriveId', metadata.drive_id],
    ['ItemId', metadata.item_id],
  ];

  return ordered
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([label, value]) => `${CSV_COMMENT_PREFIX} ${label}: ${value}`)
    .join('\n');
}

function parseCsvComments(csvText) {
  const meta = {};
  const contentLines = [];
  const lines = csvText.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith(CSV_COMMENT_PREFIX)) {
      const comment = trimmed.slice(1).trim();

      // New simple format: "# Key: Value"
      const simpleMatch = comment.match(/^(BrowserURL|Workbook|Sheet|DriveId|ItemId)\s*:\s*(.*)$/i);
      if (simpleMatch) {
        const rawKey = simpleMatch[1].toLowerCase();
        const value = simpleMatch[2].trim();
        const keyMap = {
          browserurl: 'browser_url',
          workbook: 'workbook_name',
          sheet: 'sheet_name',
          driveid: 'drive_id',
          itemid: 'item_id',
        };
        meta[keyMap[rawKey]] = value;
        continue;
      }

      // Backward-compatible format: "# padd.excel.key=value"
      if (comment.startsWith('padd.excel.')) {
        const idx = comment.indexOf('=');
        if (idx > 0) {
          const key = comment.slice('padd.excel.'.length, idx).trim();
          const value = comment.slice(idx + 1).trim();
          meta[key] = value;
        }
      }

      continue;
    }

    contentLines.push(line);
  }

  return {
    meta,
    csvBody: contentLines.join('\n').trim(),
  };
}

function toDurationStringFromExcelFraction(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric >= 1) return value;

  const totalSeconds = Math.round(numeric * 86400);
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function normalizeDurationColumn(values) {
  if (!Array.isArray(values) || values.length < 2) return values;

  const headers = Array.isArray(values[0]) ? values[0] : [];
  const durationIndex = headers.findIndex(
    (h) => String(h || '').trim().toLowerCase() === 'duration'
  );

  if (durationIndex < 0) return values;

  return values.map((row, index) => {
    if (index === 0 || !Array.isArray(row)) return row;

    const nextRow = row.slice();
    nextRow[durationIndex] = toDurationStringFromExcelFraction(nextRow[durationIndex]);
    return nextRow;
  });
}

function normalizeHeaderName(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function alignValuesToExistingHeaderContract(filePath, values) {
  if (!Array.isArray(values) || values.length === 0) return values;
  let existingHeader = null;

  if (fs.existsSync(filePath)) {
    const existingRaw = fs.readFileSync(filePath, 'utf8');
    const parsedExisting = parseCsvComments(existingRaw);
    const existingRows = parsedExisting.csvBody ? csvToArray(parsedExisting.csvBody) : [];
    if (existingRows.length > 0 && Array.isArray(existingRows[0]) && existingRows[0].length > 0) {
      existingHeader = existingRows[0].map((h) => String(h || '').trim());
    }
  }

  const incomingHeader = Array.isArray(values[0]) ? values[0].map((h) => String(h || '').trim()) : [];

  if (incomingHeader.length === 0) return values;

  const contractHeader = (existingHeader && existingHeader.length > 0)
    ? existingHeader
    : incomingHeader;

  const incomingIndexByName = new Map();
  incomingHeader.forEach((name, index) => {
    const normalized = normalizeHeaderName(name);
    if (normalized && !incomingIndexByName.has(normalized)) {
      incomingIndexByName.set(normalized, index);
    }
  });

  const aligned = [contractHeader];

  for (let rowIndex = 1; rowIndex < values.length; rowIndex++) {
    const sourceRow = Array.isArray(values[rowIndex]) ? values[rowIndex] : [];
    const targetRow = contractHeader.map((headerName) => {
      const sourceIndex = incomingIndexByName.get(normalizeHeaderName(headerName));
      if (sourceIndex === undefined) return '';
      return sourceRow[sourceIndex] ?? '';
    });
    aligned.push(targetRow);
  }

  return aligned;
}

function normalizeConfigShape(rawConfig, configPath, profile = 'schedule', accessToken = null) {
  const baseDir = path.dirname(configPath);

  if (rawConfig.sharepoint?.excel) {
    const cfg = getExcelProfileConfig(rawConfig.sharepoint.excel, profile);
    if (cfg) {
      return {
        source: 'sharepoint.excel',
        baseDir,
        sharingUrl: cfg.sharing_url || cfg.sharingUrl,
        sheets: Array.isArray(cfg.sheets)
          ? cfg.sheets.map((s) => ({
              key: s.key || s.name,
              name: s.name,
              localFile: s.localFile || s.file,
            }))
          : parseYamlSheetMapObject(cfg.sheets || {}, cfg.local_files || cfg.localFiles || {}),
        accessToken: accessToken || rawConfig?.sharepoint?.access_token || rawConfig?.sharepoint?.accessToken || null,
      };
    }
  }

  if (rawConfig.sharepointExcel) {
    const cfg = rawConfig.sharepointExcel;
    return {
      source: 'sharepointExcel',
      baseDir,
      sharingUrl: cfg.sharingUrl,
      sheets: Array.isArray(cfg.sheets)
        ? cfg.sheets.map((s) => ({
            key: s.key || s.name,
            name: s.name,
            localFile: s.localFile,
          }))
        : parseYamlSheetMapObject(cfg.sheets || {}, cfg.localFiles || {}),
      accessToken,
    };
  }

  if (rawConfig.excelSync) {
    const cfg = rawConfig.excelSync;
    return {
      source: 'excelSync',
      baseDir,
      sharingUrl: cfg.sharingUrl,
      sheets: Array.isArray(cfg.sheets)
        ? cfg.sheets.map((s) => ({
            key: s.key || s.name,
            name: s.name,
            localFile: s.localFile,
          }))
        : parseYamlSheetMapObject(cfg.sheets || {}, cfg.localFiles || {}),
      accessToken,
    };
  }

  if (rawConfig.talk?.excel?.[profile]) {
    const cfg = rawConfig.talk.excel[profile];

    if (profile === 'schedule') {
      const defaults = {
        topics: 'topics_backlog.csv',
        schedule: 'schedule.csv',
      };

      return {
        source: `talk.excel.${profile}`,
        baseDir,
        sharingUrl: cfg.sharingUrl,
        sheets: parseLegacyTalkSheetMap(cfg.sheets || {}, cfg.localFiles || defaults),
        accessToken,
      };
    }

    if (profile === 'feedback') {
      const sheetName = cfg.sheetName || 'Sheet1';
      const localFile = cfg.localFile || 'feedback.csv';

      return {
        source: `talk.excel.${profile}`,
        baseDir,
        sharingUrl: cfg.sharingUrl,
        sheets: [{ key: profile, name: sheetName, localFile }],
        accessToken,
      };
    }
  }

  throw new Error(
    `Unsupported Excel sync config format in ${configPath}.\n` +
      `Expected one of: sharepointExcel, excelSync, or talk.excel.<profile>.`
  );
}

function validateNormalizedConfig(normalized, configPath) {
  if (!normalized.sharingUrl) {
    throw new Error(`Missing sharingUrl in ${configPath}`);
  }

  if (!Array.isArray(normalized.sheets) || normalized.sheets.length === 0) {
    throw new Error(`No sheets configured in ${configPath}`);
  }

  for (const sheet of normalized.sheets) {
    if (!sheet.name) {
      throw new Error(`A sheet entry is missing 'name' in ${configPath}`);
    }
    if (!sheet.localFile) {
      throw new Error(
        `Sheet '${sheet.name}' is missing localFile. ` +
          `Define sharepointExcel.localFiles or set localFile explicitly.`
      );
    }
  }

  if (!normalized.accessToken) {
    throw new Error(
      `Missing SharePoint access token for Excel sync.\n` +
        `Expected sharepoint.access_token in YAML config discovered from current directory up to ancestors.\n` +
        `Config used: ${configPath}`
    );
  }
}

export function resolveExcelSyncConfig(options = {}) {
  const {
    startDir = process.cwd(),
    configPath = null,
    profile = 'schedule',
  } = options;

  const { config: coreConfig, configPath: coreConfigPath } = loadCoreConfig({
    startDir,
    required: false,
  });
  const accessToken = coreConfig
    ? getSharePointAccessToken(coreConfig, { required: false, configPath: coreConfigPath || 'core config' })
    : null;

  const resolvedConfigPath =
    configPath ||
    findConfigPath({
      startDir,
      configFilenames: DEFAULT_EXCEL_CONFIG_FILENAMES,
      requireWorkspaceConfig: false,
    });

  if (!resolvedConfigPath) {
    throw new Error(
      `No Excel sync config found.\n` +
        `Searched from: ${startDir}\n` +
        `Filenames: ${DEFAULT_EXCEL_CONFIG_FILENAMES.join(', ')}\n\n` +
        `Tip: place .padd.yaml next to schedule.csv for local config.`
    );
  }

  const rawConfig = resolvedConfigPath.endsWith('.yaml') || resolvedConfigPath.endsWith('.yml')
    ? loadCoreConfigFile(resolvedConfigPath)
    : loadConfigFile(resolvedConfigPath);
  const normalized = normalizeConfigShape(rawConfig, resolvedConfigPath, profile, accessToken);
  validateNormalizedConfig(normalized, resolvedConfigPath);

  return {
    ...normalized,
    configPath: resolvedConfigPath,
    sheets: normalized.sheets.map((sheet) => ({
      ...sheet,
      filePath: path.resolve(normalized.baseDir, sheet.localFile),
    })),
  };
}

export async function resolveDriveItemFromSharingUrl(client, sharingUrl) {
  const shareToken = sharingUrlToToken(sharingUrl);

  try {
    return await client.request(`/shares/${shareToken}/driveItem`);
  } catch (error) {
    const parsedRLink = parseSharePointRFileLink(sharingUrl);
    if (!parsedRLink) {
      const parsedBrowserLink = parseSharePointBrowserExcelLink(sharingUrl);
      if (!parsedBrowserLink) {
        throw error;
      }

      return resolveDriveItemFromBrowserExcelUrl(client, parsedBrowserLink);
    }

    const site = await client.request(`/sites/${parsedRLink.host}:${parsedRLink.sitePath}`);
    if (!site?.id) {
      throw error;
    }

    return client.request(`/sites/${site.id}/drive/root:/${encodeURIComponent(parsedRLink.drivePath)}`);
  }
}

async function resolveWorkbookTarget(client, options = {}) {
  const { sharingUrl, driveId, itemId } = options;

  if (driveId && itemId) {
    const driveItem = await client.request(`/drives/${driveId}/items/${itemId}`);
    return { driveItem, driveId, itemId, source: 'drive-item-id' };
  }

  if (sharingUrl) {
    const driveItem = await resolveDriveItemFromSharingUrl(client, sharingUrl);
    const resolvedDriveId = driveItem.parentReference?.driveId;
    const resolvedItemId = driveItem.id;

    if (!resolvedDriveId || !resolvedItemId) {
      throw new Error('Unable to resolve driveId/itemId from sharing URL');
    }

    return {
      driveItem,
      driveId: resolvedDriveId,
      itemId: resolvedItemId,
      source: 'sharing-url',
    };
  }

  throw new Error('Missing workbook target. Provide sharingUrl or both driveId and itemId.');
}

function worksheetPath(driveId, itemId, sheetName) {
  const safeSheetName = encodeURIComponent(sheetName);
  return `/drives/${driveId}/items/${itemId}/workbook/worksheets('${safeSheetName}')`;
}

export async function pullWorksheetValues(client, driveId, itemId, sheetName) {
  const endpoint = `${worksheetPath(driveId, itemId, sheetName)}/usedRange`;
  const data = await client.request(endpoint);
  return Array.isArray(data.values) ? data.values : [];
}

export async function clearWorksheetValues(client, driveId, itemId, sheetName) {
  const endpoint = `${worksheetPath(driveId, itemId, sheetName)}/usedRange/clear`;
  await client.request(endpoint, {
    method: 'POST',
    body: JSON.stringify({ applyTo: 'All' }),
  });
}

async function getUsedRangeDimensions(client, driveId, itemId, sheetName) {
  const endpoint = `${worksheetPath(driveId, itemId, sheetName)}/usedRange`;

  try {
    const data = await client.request(endpoint);
    const values = Array.isArray(data.values) ? data.values : [];
    const rows = values.length;
    const cols = rows > 0 ? Math.max(...values.map((row) => row.length)) : 0;
    return { rows, cols };
  } catch {
    return { rows: 0, cols: 0 };
  }
}

function buildEmptyMatrix(rows, cols) {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => ''));
}

export async function pushWorksheetValues(client, driveId, itemId, sheetName, values) {
  const oldDims = await getUsedRangeDimensions(client, driveId, itemId, sheetName);

  if (!values || values.length === 0) {
    // Clear only cell values in prior used range, preserving style/format/validation.
    if (oldDims.rows > 0 && oldDims.cols > 0) {
      const clearRange = buildA1Range(oldDims.rows, oldDims.cols);
      const clearEndpoint = `${worksheetPath(driveId, itemId, sheetName)}/range(address='${clearRange}')`;
      await client.request(clearEndpoint, {
        method: 'PATCH',
        body: JSON.stringify({ values: buildEmptyMatrix(oldDims.rows, oldDims.cols) }),
      });
    }

    return { clearedOnly: true, range: null, rows: 0, cols: 0 };
  }

  const rows = values.length;
  const cols = Math.max(...values.map((row) => row.length));
  const paddedValues = values.map((row) => {
    const clone = row.slice();
    while (clone.length < cols) clone.push('');
    return clone;
  });

  const range = buildA1Range(rows, cols);
  const endpoint = `${worksheetPath(driveId, itemId, sheetName)}/range(address='${range}')`;

  await client.request(endpoint, {
    method: 'PATCH',
    body: JSON.stringify({ values: paddedValues }),
  });

  // If incoming data is smaller than previous used range, blank trailing cells by value only.
  if (oldDims.rows > rows || oldDims.cols > cols) {
    const maxRows = Math.max(oldDims.rows, rows);
    const maxCols = Math.max(oldDims.cols, cols);
    const fullRange = buildA1Range(maxRows, maxCols);

    const merged = buildEmptyMatrix(maxRows, maxCols);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        merged[r][c] = paddedValues[r][c];
      }
    }

    const fullEndpoint = `${worksheetPath(driveId, itemId, sheetName)}/range(address='${fullRange}')`;
    await client.request(fullEndpoint, {
      method: 'PATCH',
      body: JSON.stringify({ values: merged }),
    });
  }

  return { clearedOnly: false, range, rows, cols };
}

export async function pullExcelSheets(options = {}) {
  const { accessToken, sharingUrl, driveId, itemId, sheets } = options;

  if (!accessToken) throw new Error('Missing accessToken');
  if (!sharingUrl && !(driveId && itemId)) {
    throw new Error('Missing workbook target: sharingUrl or driveId+itemId');
  }
  if (!Array.isArray(sheets) || sheets.length === 0) throw new Error('No sheets provided');

  const client = new SharePointClient({ accessToken });
  const resolved = await resolveWorkbookTarget(client, { sharingUrl, driveId, itemId });
  const resolvedDriveId = resolved.driveId;
  const resolvedItemId = resolved.itemId;
  const driveItem = resolved.driveItem;

  const output = [];

  for (const sheet of sheets) {
    const rawValues = await pullWorksheetValues(client, resolvedDriveId, resolvedItemId, sheet.name);
    const alignedValues = alignValuesToExistingHeaderContract(sheet.filePath, rawValues);
    const values = normalizeDurationColumn(alignedValues);
    const csv = arrayToCsv(values);
    const comments = buildCsvComments({
      browser_url: driveItem.webUrl,
      drive_id: resolvedDriveId,
      item_id: resolvedItemId,
      sheet_name: sheet.name,
      workbook_name: driveItem.name,
    });
    const content = comments ? `${comments}\n${csv}` : csv;

    fs.mkdirSync(path.dirname(sheet.filePath), { recursive: true });
    fs.writeFileSync(sheet.filePath, content, 'utf8');

    output.push({
      sheet: sheet.name,
      filePath: sheet.filePath,
      rows: values.length,
    });
  }

  return {
    driveItemName: driveItem.name,
    driveId: resolvedDriveId,
    itemId: resolvedItemId,
    results: output,
  };
}

export async function pushExcelSheets(options = {}) {
  const { accessToken, sharingUrl, driveId, itemId, sheets } = options;

  if (!accessToken) throw new Error('Missing accessToken');
  if (!sharingUrl && !(driveId && itemId)) {
    throw new Error('Missing workbook target: sharingUrl or driveId+itemId');
  }
  if (!Array.isArray(sheets) || sheets.length === 0) throw new Error('No sheets provided');

  const client = new SharePointClient({ accessToken });
  const resolved = await resolveWorkbookTarget(client, { sharingUrl, driveId, itemId });
  const resolvedDriveId = resolved.driveId;
  const resolvedItemId = resolved.itemId;
  const driveItem = resolved.driveItem;

  const output = [];

  for (const sheet of sheets) {
    if (!fs.existsSync(sheet.filePath)) {
      throw new Error(`Local file not found for sheet '${sheet.name}': ${sheet.filePath}`);
    }

    const csv = fs.readFileSync(sheet.filePath, 'utf8');
    const parsed = parseCsvComments(csv);

    if (parsed.meta.sheet_name && parsed.meta.sheet_name !== sheet.name) {
      throw new Error(
        `CSV metadata sheet mismatch for ${sheet.filePath}. ` +
          `Comment says '${parsed.meta.sheet_name}', command targets '${sheet.name}'.`
      );
    }

    const values = parsed.csvBody ? csvToArray(parsed.csvBody) : [];
    const pushResult = await pushWorksheetValues(client, resolvedDriveId, resolvedItemId, sheet.name, values);

    output.push({
      sheet: sheet.name,
      filePath: sheet.filePath,
      rows: values.length,
      range: pushResult.range,
      clearedOnly: pushResult.clearedOnly,
    });
  }

  return {
    driveItemName: driveItem.name,
    driveId: resolvedDriveId,
    itemId: resolvedItemId,
    results: output,
  };
}
