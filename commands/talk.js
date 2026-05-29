#!/usr/bin/env node

/**
 * padd talk - Talk workflow helpers
 *
 * - init: create local talk root/archive/year pages + save SharePoint archive URL only
 * - msg: generate temporary markdown announcements from schedule.csv
 * - video: update processed video url in schedule.csv and resolve/cache archive IDs when possible
 * - page: upsert local markdown page for a selected talk (no upload)
 */

import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import nunjucks from 'nunjucks';
import readline from 'readline';
import fetch from 'node-fetch';
import { csvToObjects, csvToArray, objectsToCsv } from '../lib/csv-utils.js';
import { loadCoreConfig, findCoreConfigPath } from '../lib/core-config.js';
import { SharePointClient } from '../lib/sharepoint-client.js';
import { loadAuth } from '../lib/auth-storage.js';

function showHelp() {
  console.log(`
padd talk - Talk workflow helpers

USAGE
  padd talk <init|msg|video|page> [shared-options]

COMMANDS
  init                  Initialize talk workspace and store SharePoint archive URL
  msg                   Generate message markdown for one talk
  video                 Archive/update talk video and sync CSV link
  page                  Generate local talk page markdown

SHARED OPTIONS
  --talk <number>       Select the talk to operate on by number
  --date <YYYY-MM-DD>   Select the talk to operate on by date
  --schedule <path>     Override CSV file path (optional)
`);
}

function parseArgs(args) {
  const options = {
    schedulePath: 'talks.csv',
    talk: null,
    date: null,
    space: null,
    parentPageId: null,
    videoArchiveUrl: null,
    excelSharingUrl: null,
    excelSheetName: null,
    seriesTitle: null,
    seriesKey: null,
    year: null,
    force: false,
  };

  const positional = [];

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

    if (arg === '--space') {
      options.space = args[++i];
      continue;
    }

    if (arg === '--parent-page-id' || arg === '--root-page-id') {
      options.parentPageId = args[++i];
      continue;
    }

    if (arg === '--video-archive-url' || arg === '--video-archive-share-url') {
      options.videoArchiveUrl = args[++i];
      continue;
    }

    if (arg === '--excel-sharing-url' || arg === '--excel-share-url') {
      options.excelSharingUrl = args[++i];
      continue;
    }

    if (arg === '--excel-sheet') {
      options.excelSheetName = args[++i];
      continue;
    }

    if (arg === '--series-title') {
      options.seriesTitle = args[++i];
      continue;
    }

    if (arg === '--series-key') {
      options.seriesKey = args[++i];
      continue;
    }

    if (arg === '--year') {
      options.year = args[++i];
      continue;
    }

    if (arg === '--schedule') {
      options.schedulePath = args[++i];
      continue;
    }

    if (arg === '--talk') {
      options.talk = args[++i];
      continue;
    }

    if (arg === '--date') {
      options.date = args[++i];
      continue;
    }

    if (arg === '--out') {
      options.outPath = args[++i];
      continue;
    }

    if (arg === '--time') {
      options.time = args[++i];
      continue;
    }

    if (arg === '--duration') {
      options.duration = args[++i];
      continue;
    }

    if (arg === '--attendees') {
      options.attendees = args[++i];
      continue;
    }

    if (arg === '--feedback-url') {
      options.feedbackUrl = args[++i];
      continue;
    }

    if (!arg.startsWith('--')) {
      positional.push(arg);
    }
  }

  return {
    command: positional[0],
    options,
  };
}

function readCsvWithoutComments(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return raw
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

function resolveSchedulePath(rawPath, rootDir, options = {}) {
  // Explicit --schedule overrides everything
  if (rawPath && rawPath !== 'talks.csv') {
    return path.isAbsolute(rawPath)
      ? rawPath
      : path.resolve(process.cwd(), rawPath);
  }

  // Infer year: --date > --year > current year
  let year = String(new Date().getFullYear());
  if (options.date) {
    const match = String(options.date).match(/^(\d{4})/);
    if (match) year = match[1];
  } else if (options.year) {
    year = String(options.year);
  }

  // Prefer talks_YYYY.csv, fall back to talks.csv
  const yearCsv = path.resolve(rootDir, `talks_${year}.csv`);
  if (fs.existsSync(yearCsv)) {
    return yearCsv;
  }

  return path.resolve(rootDir, 'talks.csv');
}

function isConfiguredValue(value) {
  const normalized = String(value || '').trim();
  return normalized !== '' && !/^REPLACE_/i.test(normalized) && normalized !== 'CHANGE_ME';
}

function getMsGraphAccessToken(coreConfig) {
  const fromConfig = String(
    coreConfig?.sharepoint?.access_token
    || coreConfig?.sharepoint?.accessToken
    || ''
  ).trim();

  if (fromConfig && !fromConfig.startsWith('REPLACE_')) {
    return fromConfig;
  }

  const { auth } = loadAuth({
    startDir: process.cwd(),
    required: false,
    silent: true,
  });

  return String(auth?.providers?.['ms-graph']?.access_token || '').trim() || null;
}

async function resolveSharePointArchiveFromUrl(shareUrl, coreConfig) {
  const accessToken = getMsGraphAccessToken(coreConfig);
  if (!accessToken) {
    throw new Error('Missing Microsoft Graph token. Set sharepoint.access_token or run: padd auth refresh ms-graph');
  }

  const client = new SharePointClient({ accessToken });
  const item = await client.resolveShareLink(shareUrl);
  if (!item?.folder) {
    throw new Error('Share URL must point to a SharePoint folder (archive root).');
  }

  let siteId = String(item?.sharepointIds?.siteId || '').trim();
  const driveId = String(item?.parentReference?.driveId || '').trim();
  const archiveParentId = String(item?.id || '').trim();

  if (!siteId && item?.webUrl) {
    const url = new URL(item.webUrl);
    const host = url.host;
    const siteName = url.pathname.split('/')[2] || '';
    if (siteName) {
      const site = await client.request(`/sites/${host}:/sites/${siteName}`);
      siteId = String(site?.id || '').trim();
    }
  }

  if (!siteId || !driveId || !archiveParentId) {
    throw new Error('Could not resolve required SharePoint IDs from archive folder URL (site_id, drive_id, folder_id).');
  }

  return {
    siteId,
    driveId,
    archiveParentId,
  };
}

function applySharePointArchiveDefaults(videoArchiveConfig) {
  if (!videoArchiveConfig.folder_id && videoArchiveConfig.archive_parent_id) {
    videoArchiveConfig.folder_id = videoArchiveConfig.archive_parent_id;
  }
}

function getSharePointVideoArchiveConfig(coreConfig) {
  const talk = coreConfig?.talk || {};
  const current = talk?.video_archive || {};
  const legacyTalkSharepoint = talk?.sharepoint?.video_archive || {};
  const legacySharepointTalk = coreConfig?.sharepoint?.talk?.video_archive || {};

  return {
    url: trimCell(talk?.video_archive_url)
      || trimCell(current.url)
      || trimCell(current.share_url)
      || trimCell(legacyTalkSharepoint.url)
      || trimCell(legacyTalkSharepoint.share_url)
      || trimCell(legacySharepointTalk.url)
      || trimCell(legacySharepointTalk.share_url),
    site_id: trimCell(current.site_id)
      || trimCell(legacyTalkSharepoint.site_id)
      || trimCell(legacySharepointTalk.site_id),
    drive_id: trimCell(current.drive_id)
      || trimCell(legacyTalkSharepoint.drive_id)
      || trimCell(legacySharepointTalk.drive_id),
    folder_id: trimCell(current.folder_id)
      || trimCell(current.archive_parent_id)
      || trimCell(legacyTalkSharepoint.folder_id)
      || trimCell(legacyTalkSharepoint.archive_parent_id)
      || trimCell(legacySharepointTalk.folder_id)
      || trimCell(legacySharepointTalk.archive_parent_id),
  };
}

function isSharePointVideoConfigured(coreConfig) {
  const cfg = getSharePointVideoArchiveConfig(coreConfig);
  return isConfiguredValue(cfg?.site_id)
    && isConfiguredValue(cfg?.drive_id)
    && isConfiguredValue(cfg?.folder_id);
}

function isConfluenceConfigured(coreConfig) {
  const confluence = coreConfig?.confluence || {};
  const legacyTalk = coreConfig?.talk?.confluence || coreConfig?.confluence?.talk || {};
  const space = confluence.space || legacyTalk.space;
  const rootPageId = confluence.root_page_id || confluence.root_page || legacyTalk.root_page_id || legacyTalk.parent_page_id;
  return isConfiguredValue(space) && isConfiguredValue(rootPageId);
}

function buildPreviewUrlFromWebUrl(webUrl) {
  const parsed = new URL(webUrl);
  const siteName = parsed.pathname.split('/')[2];
  const siteUrl = `${parsed.protocol}//${parsed.host}/sites/${siteName}`;
  const serverRelativePath = decodeURIComponent(parsed.pathname);
  const encodedPath = encodeURIComponent(serverRelativePath);
  return `${siteUrl}/_layouts/15/stream.aspx?id=${encodedPath}`;
}

function resolveSpeakerPrimaryValue(speakerValue) {
  if (Array.isArray(speakerValue)) {
    return String(speakerValue[0] || '').trim();
  }

  return String(speakerValue || '').trim();
}

function computeVideoTemplateVars(talkRow, coreConfig) {
  const title = trimCell(talkRow['Title']) || 'TBD';
  const rawSpeaker = trimCell(talkRow['Speaker']);
  const speakers = parseCsvList(rawSpeaker);
  const speaker = rawSpeaker || 'TBD';
  const speakerPrimary = resolveSpeakerPrimaryValue(speakers.length > 0 ? speakers : speaker) || 'TBD';
  const talkPrefix = trimCell(coreConfig?.talk?.prefix) || 'TALK';
  const seasonEpisode = computeSeasonEpisode(talkRow);
  const talkContext = {
    prefix: talkPrefix,
    season_episode: seasonEpisode,
    seasonEpisode,
    title,
    speaker: speaker,
    speaker_first: speaker,
    speakers,
    speaker_primary: speakerPrimary,
    speakerPrimary: speakerPrimary,
  };

  return {
    TalkPrefix: talkPrefix,
    SeasonEpisode: seasonEpisode,
    Title: title,
    Speaker: speaker,
    talk_prefix: talkPrefix,
    season_episode: seasonEpisode,
    title,
    speaker,
    speaker_first: speaker,
    speakers,
    speaker_primary: speakerPrimary,
    talk: talkContext,
  };
}

function computeVideoFileName(talkRow, coreConfig, currentFileName) {
  const vars = computeVideoTemplateVars(talkRow, coreConfig);
  const format = trimCell(coreConfig?.talk?.video_filename_format)
    || trimCell(coreConfig?.talk?.sharepoint?.video_archive?.filename_format)
    || trimCell(coreConfig?.sharepoint?.talk?.video_archive?.filename_format)
    || '{{ talk.prefix }} {{ talk.season_episode }} - {{ talk.title }}';
  const ext = path.extname(currentFileName || '') || '.mp4';
  const rendered = sanitizeFileName(renderTemplate(format, vars)).trim() || 'talk-video';
  return rendered.endsWith(ext) ? rendered : `${rendered}${ext}`;
}

function computeVideoDisplayTitle(talkRow, coreConfig) {
  const vars = computeVideoTemplateVars(talkRow, coreConfig);
  const format = trimCell(coreConfig?.talk?.video_title_format)
    || trimCell(coreConfig?.talk?.sharepoint?.video_archive?.title_format)
    || trimCell(coreConfig?.sharepoint?.talk?.video_archive?.title_format)
    || '{{ talk.prefix }} {{ talk.season_episode }} | {{ talk.title }}';
  return renderTemplate(format, vars).trim();
}

function formatVideoDuration(durationMs) {
  if (durationMs === null || durationMs === undefined || durationMs === '') {
    return '';
  }

  const totalMs = Number(durationMs);
  if (!Number.isFinite(totalMs) || totalMs < 0) {
    return '';
  }

  const totalSeconds = Math.floor(totalMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
}

function extractVideoDurationValue(...items) {
  for (const item of items) {
    const candidate = item?.video?.duration ?? item?.media?.duration;
    const formatted = formatVideoDuration(candidate);
    if (formatted) {
      return formatted;
    }
  }

  return '';
}

function parseTeamsRecapInfo(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    const isTeamsRecap = /(^|\.)teams\.microsoft\.com$/i.test(parsed.hostname)
      && parsed.pathname.startsWith('/l/meetingrecap');

    if (!isTeamsRecap) {
      return { isTeamsRecap: false, normalizedUrl: String(rawUrl || '').trim(), driveId: '', driveItemId: '' };
    }

    const fileUrl = String(parsed.searchParams.get('fileUrl') || '').trim();
    const driveId = String(parsed.searchParams.get('driveId') || '').trim();
    const driveItemId = String(parsed.searchParams.get('driveItemId') || '').trim();

    return {
      isTeamsRecap: true,
      normalizedUrl: fileUrl || String(rawUrl || '').trim(),
      driveId,
      driveItemId,
    };
  } catch {
    return { isTeamsRecap: false, normalizedUrl: String(rawUrl || '').trim(), driveId: '', driveItemId: '' };
  }
}

async function resolveSourceVideoItem(client, inputUrl) {
  const recap = parseTeamsRecapInfo(inputUrl);

  try {
    return await client.resolveShareLink(recap.normalizedUrl);
  } catch (error) {
    if (recap.isTeamsRecap && recap.driveId && recap.driveItemId) {
      return client.request(`/drives/${recap.driveId}/items/${recap.driveItemId}`);
    }
    throw error;
  }
}

async function waitForCopyCompletion(monitorUrl, accessToken) {
  const maxAttempts = 30;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetch(monitorUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (response.status === 200) {
      return response.json();
    }

    if (response.status !== 202) {
      const error = await response.text();
      throw new Error(`Copy failed while polling operation status: ${error}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error('Copy operation timed out after 30 seconds.');
}

async function waitForVideoFacet(client, driveId, itemId, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 20000);
  const intervalMs = Number(options.intervalMs || 2500);
  const startedAt = Date.now();

  while ((Date.now() - startedAt) < timeoutMs) {
    const item = await client.request(`/drives/${driveId}/items/${itemId}?$select=id,name,webUrl,parentReference,video`);
    if (item?.video?.duration !== undefined && item?.video?.duration !== null) {
      return item;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return null;
}

async function hydrateItemWithVideoFacet(client, item, fallbackDriveId = '') {
  const itemId = trimCell(item?.id);
  const driveId = trimCell(item?.parentReference?.driveId) || trimCell(fallbackDriveId);

  if (!itemId || !driveId) {
    return item;
  }

  try {
    return await client.request(`/drives/${driveId}/items/${itemId}?$select=id,name,webUrl,parentReference,video`);
  } catch {
    return item;
  }
}

async function archiveVideoToSharePoint({ shareUrl, talkRow, coreConfig }) {
  const accessToken = getMsGraphAccessToken(coreConfig);
  if (!accessToken) {
    throw new Error('Missing Microsoft Graph token. Set sharepoint.access_token or run: padd auth refresh ms-graph');
  }

  const videoArchiveConfig = getSharePointVideoArchiveConfig(coreConfig);
  const siteId = trimCell(videoArchiveConfig?.site_id);
  const targetDriveId = trimCell(videoArchiveConfig?.drive_id);
  const archiveParentId = trimCell(videoArchiveConfig?.folder_id);

  const talkDate = trimCell(talkRow['Date']);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(talkDate)) {
    throw new Error('Selected talk has invalid Date value in schedule.csv (expected YYYY-MM-DD).');
  }

  const year = talkDate.slice(0, 4);
  const client = new SharePointClient({ accessToken });
  let source = await resolveSourceVideoItem(client, shareUrl);
  source = await hydrateItemWithVideoFacet(client, source, trimCell(source?.parentReference?.driveId));

  if (!source?.id || !source?.name) {
    throw new Error('Could not resolve source video from share URL.');
  }

  const yearFolder = await client.ensureSiteFolderExists(siteId, archiveParentId, year);
  const desiredFileName = computeVideoFileName(talkRow, coreConfig, source.name);
  const desiredTitle = computeVideoDisplayTitle(talkRow, coreConfig);

  const sourceDriveId = trimCell(source?.parentReference?.driveId);
  const sourceParentId = trimCell(source?.parentReference?.id);

  let finalItem = source;
  const sameDrive = sourceDriveId === targetDriveId;
  const sameFolder = sameDrive && sourceParentId === trimCell(yearFolder?.id);

  if (sameFolder) {
    if (trimCell(source.name) !== desiredFileName) {
      finalItem = await client.request(`/drives/${targetDriveId}/items/${source.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: desiredFileName }),
      });
    }
  } else if (sameDrive) {
    finalItem = await client.request(`/drives/${targetDriveId}/items/${source.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        parentReference: { id: yearFolder.id },
        name: desiredFileName,
      }),
    });
  } else {
    const copyResult = await client.request(`/drives/${sourceDriveId}/items/${source.id}/copy`, {
      method: 'POST',
      body: JSON.stringify({
        name: desiredFileName,
        parentReference: {
          driveId: targetDriveId,
          id: yearFolder.id,
        },
      }),
    });

    if (!copyResult?.monitorUrl && !copyResult?.location) {
      throw new Error('Copy operation did not return monitor URL.');
    }

    finalItem = await waitForCopyCompletion(copyResult.monitorUrl || copyResult.location, accessToken);
    await client.request(`/drives/${sourceDriveId}/items/${source.id}`, { method: 'DELETE' });
  }

  // Enforce final naming in target drive after move/copy, even if upstream operation kept original name.
  if (trimCell(finalItem?.name) !== desiredFileName && finalItem?.id) {
    finalItem = await client.request(`/drives/${targetDriveId}/items/${finalItem.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: desiredFileName }),
    });
  }

  let metadataWarning = '';
  // Keep metadata update best-effort so archive flow doesn't fail on eventual-consistency 404s.
  try {
    await client.updateVideoMetadata(siteId, finalItem.id, {
      title: desiredTitle,
      noExpiration: true,
    });
  } catch (error) {
    const msg = String(error?.message || '');
    if (/itemNotFound|\b404\b/i.test(msg)) {
      metadataWarning = 'metadata update skipped (item not found yet); file was archived successfully';
    } else {
      throw error;
    }
  }

  let refreshed = await client.request(`/drives/${targetDriveId}/items/${finalItem.id}?$select=id,name,webUrl,parentReference,video`);
  let duration = extractVideoDurationValue(refreshed, finalItem, source);

  if (!duration) {
    const maybeIndexed = await waitForVideoFacet(client, targetDriveId, finalItem.id, {
      timeoutMs: 20000,
      intervalMs: 2500,
    });
    if (maybeIndexed) {
      refreshed = maybeIndexed;
      duration = extractVideoDurationValue(refreshed, finalItem, source);
    }
  }

  const previewUrl = buildPreviewUrlFromWebUrl(refreshed.webUrl);

  return {
    previewUrl,
    finalName: refreshed.name,
    year,
    metadataWarning,
    duration,
  };
}

function normalizeIntegrationTokenConfig(config) {
  const confluence = ensureObject(config, 'confluence');
  const sharepoint = ensureObject(config, 'sharepoint');

  if (!isConfiguredValue(confluence.access_token)) {
    delete confluence.access_token;
  }

  if (!isConfiguredValue(sharepoint.access_token)) {
    delete sharepoint.access_token;
  }
}

function appendInlineTokenPlaceholders(configPath, config) {
  const needsConfluenceToken = !isConfiguredValue(config?.confluence?.access_token);
  const needsSharepointToken = !isConfiguredValue(config?.sharepoint?.access_token);
  const needsPrefiledLink = !isConfiguredValue(config?.talk?.prefiledlink)
    && !isConfiguredValue(config?.talk?.prefilledlink)
    && !isConfiguredValue(config?.talk?.feedback_url_format)
    && !isConfiguredValue(config?.talk?.feedback_url);

  if (!needsConfluenceToken && !needsSharepointToken && !needsPrefiledLink) {
    return;
  }

  let raw = fs.readFileSync(configPath, 'utf8');

  if (
    needsSharepointToken
    && !/^\s*#\s*access_token:\s*REPLACE_MS_GRAPH_ACCESS_TOKEN\s*$/m.test(raw)
  ) {
    raw = raw.replace(
      /^sharepoint:\s*(?:\{\s*\})?\s*$/m,
      'sharepoint:\n  # access_token: REPLACE_MS_GRAPH_ACCESS_TOKEN'
    );
  }

  if (
    needsConfluenceToken
    && !/^\s*#\s*access_token:\s*REPLACE_CONFLUENCE_ACCESS_TOKEN\s*$/m.test(raw)
  ) {
    raw = raw.replace(
      /^confluence:\s*(?:\{\s*\})?\s*$/m,
      'confluence:\n  # access_token: REPLACE_CONFLUENCE_ACCESS_TOKEN'
    );
  }

  if (
    needsPrefiledLink
    && !/^\s*#\s*prefiledlink:\s*https:\/\/forms\.cloud\.microsoft\/Pages\/ResponsePage\.aspx\?id=.*r854ca60c51694413ba3ef3ebbab24f21=\s*$/m.test(raw)
  ) {
    const commentedPlaceholder = '  # prefiledlink: https://forms.cloud.microsoft/Pages/ResponsePage.aspx?id=oV91K9Ej80iY_G_cHcSNaZdou5vGZYZHgfZxR6Xi5wZUQlE4UlkxMkQxSDRDNUgwMjhTV05VNEpPRy4u&r854ca60c51694413ba3ef3ebbab24f21=';

    if (/^talk:\s*(?:\{\s*\})?\s*$/m.test(raw)) {
      raw = raw.replace(/^talk:\s*(?:\{\s*\})?\s*$/m, `talk:\n${commentedPlaceholder}`);
    } else if (/^talk:\s*$/m.test(raw)) {
      raw = raw.replace(/^talk:\s*$/m, `talk:\n${commentedPlaceholder}`);
    } else {
      raw = `${raw.replace(/\s*$/, '')}\n\ntalk:\n${commentedPlaceholder}\n`;
    }
  }

  fs.writeFileSync(configPath, raw, 'utf8');
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function toIsoDate(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function formatDateLong(dateStr) {
  const d = new Date(`${dateStr}T12:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('es-AR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function formatDayName(dateStr, lowercase = false) {
  const d = new Date(`${dateStr}T12:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  const day = d.toLocaleDateString('es-AR', { weekday: 'long' });
  return lowercase ? day.toLowerCase() : day.charAt(0).toUpperCase() + day.slice(1);
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function sanitizeFileName(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>]/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();
}

function computeSeasonEpisode(talkRow) {
  const date = String(talkRow['Date'] || '').trim();
  const talkNum = Number(talkRow['Talk #'] || 0);
  const year = date ? Number(date.slice(0, 4)) : new Date().getFullYear();
  const season = String(year).slice(-2);
  const episode = talkNum > 0 ? pad2(talkNum) : '??';
  return `S${season}E${episode}`;
}

function computeTalkContentTitle(talkRow, talkConfig) {
  const prefix = String(talkConfig?.prefix || talkConfig?.confluence?.series_key || 'TALK').trim();
  const title = trimCell(talkRow['Title']) || 'TBD';
  const speaker = trimCell(talkRow['Speaker']) || 'TBD';
  const format = trimCell(talkConfig?.page_title_format || talkConfig?.confluence?.page_title_format)
    || '{{ talk.prefix }} {{ talk.season_episode }} | {{ talk.title }}';
  const vars = computeVideoTemplateVars(talkRow, { talk: { prefix } });
  vars.Speaker = speaker;
  vars.speaker = speaker;
  if (vars.talk && typeof vars.talk === 'object') {
    vars.talk.speaker = speaker;
    vars.talk.speaker_first = speaker;
    vars.talk.speaker_primary = resolveSpeakerPrimaryValue(vars.talk.speaker) || speaker;
    vars.talk.speakerPrimary = vars.talk.speaker_primary;
  }

  return renderTemplate(format, {
    ...vars,
    Title: title,
    title,
    talk: {
      ...(vars.talk || {}),
      title,
    },
  }).trim();
}

function legacyTalkPathsDetected(paths) {
  const rootPage = String(paths.root_page || '').trim();
  const archivePage = String(paths.archive_page || '').trim();
  const archiveDir = String(paths.archive_dir || '').trim();

  return rootPage === 'talks.md'
    && archivePage === 'talks/archive.md'
    && archiveDir === 'talks/archive';
}

function detectCurrentTalk(rows) {
  const now = new Date();
  const today = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;

  const eligible = rows.filter((row) => {
    const status = (row['Status'] || '').toLowerCase();
    return status === 'reservado'
      || status === 'publicado'
      || status === 'confirmado';
  });

  const upcoming = eligible
    .filter((row) => row['Date'] && row['Date'] >= today)
    .sort((a, b) => (a['Date'] || '').localeCompare(b['Date'] || ''));

  if (upcoming.length > 0) return upcoming[0];

  return rows
    .filter((row) => row['Date'])
    .sort((a, b) => (b['Date'] || '').localeCompare(a['Date'] || ''))[0] || null;
}

function findTalkRow(rows, options) {
  if (options.talk) {
    const normalized = String(options.talk).trim();
    return rows.find((row) => String(row['Talk #'] || '').trim() === normalized) || null;
  }

  if (options.date) {
    const normalizedDate = toIsoDate(options.date) || options.date;
    return rows.find((row) => String(row['Date'] || '').trim() === normalizedDate) || null;
  }

  return detectCurrentTalk(rows);
}

function defaultOutputPath(talkRow) {
  const talkNum = String(talkRow['Talk #'] || 'unknown').trim();
  return `talk${talkNum}_msg.tmp.md`;
}

const TALKS_CSV_HEADERS = [
  'Talk #', 'Status', 'Date', 'Focus', 'Title', 'Description', 'Speaker', 'Role',
  'Lead/Manager', 'Account', 'Tags', 'Notes', 'Summary', 'Links', 'Video', 'Duration', 'Confluence', 'Attendees',
];

function splitCsvCommentsAndBody(raw) {
  const lines = raw.split(/\r?\n/);
  const comments = [];
  const body = [];

  for (const line of lines) {
    if (body.length === 0 && line.trimStart().startsWith('#')) {
      comments.push(line);
    } else {
      body.push(line);
    }
  }

  return {
    comments,
    body: body.join('\n').trim(),
  };
}

function readScheduleWithComments(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const { comments, body } = splitCsvCommentsAndBody(raw);

  return {
    comments,
    body,
    rows: csvToObjects(body),
    headers: (csvToArray(body)[0] || []).map((h) => String(h || '').trim()),
  };
}

function ensureColumns(rows, headers, requiredColumns) {
  const nextHeaders = [...headers];
  for (const col of requiredColumns) {
    if (!nextHeaders.includes(col)) {
      nextHeaders.push(col);
    }
  }

  for (const row of rows) {
    for (const col of requiredColumns) {
      if (!Object.prototype.hasOwnProperty.call(row, col)) {
        row[col] = '';
      }
    }
  }

  return nextHeaders;
}

function writeScheduleWithComments(filePath, comments, rows, headers) {
  const csv = objectsToCsv(rows, headers);
  const commentBlock = comments.length > 0 ? `${comments.join('\n')}\n` : '';
  fs.writeFileSync(filePath, `${commentBlock}${csv}\n`, 'utf8');
}

function upsertCommentLine(comments, regex, value) {
  const index = comments.findIndex((line) => regex.test(line));
  if (!value) {
    if (index >= 0) comments.splice(index, 1);
    return;
  }

  if (index >= 0) {
    comments[index] = value;
    return;
  }

  comments.push(value);
}

function seedExcelMetadataComments(csvPath, { sharingUrl, sheetName }) {
  if (!sharingUrl && !sheetName) return false;
  if (!fs.existsSync(csvPath)) return false;

  const raw = fs.readFileSync(csvPath, 'utf8');
  const { comments, body } = splitCsvCommentsAndBody(raw);
  const nextComments = [...comments];

  upsertCommentLine(
    nextComments,
    /^\s*#\s*(SharingUrl\s*:|padd\.excel\.sharing_url\s*=)/i,
    sharingUrl ? `# SharingUrl: ${sharingUrl}` : ''
  );
  upsertCommentLine(
    nextComments,
    /^\s*#\s*Sheet\s*:/i,
    sheetName ? `# Sheet: ${sheetName}` : ''
  );

  const commentBlock = nextComments.length > 0 ? `${nextComments.join('\n')}\n` : '';
  const bodyBlock = body ? `${body}\n` : '';
  fs.writeFileSync(csvPath, `${commentBlock}${bodyBlock}`, 'utf8');
  return true;
}

function readExcelMetadataComments(csvPath) {
  if (!fs.existsSync(csvPath)) {
    return { sharingUrl: '', sheetName: '' };
  }

  const raw = fs.readFileSync(csvPath, 'utf8');
  const { comments } = splitCsvCommentsAndBody(raw);

  let sharingUrl = '';
  let sheetName = '';

  for (const line of comments) {
    const simpleSharingMatch = line.match(/^\s*#\s*SharingUrl\s*:\s*(.*)$/i);
    if (simpleSharingMatch) {
      sharingUrl = trimCell(simpleSharingMatch[1]);
      continue;
    }

    const browserSharingMatch = line.match(/^\s*#\s*BrowserURL\s*:\s*(.*)$/i);
    if (browserSharingMatch) {
      sharingUrl = trimCell(browserSharingMatch[1]);
      continue;
    }

    const sharingMatch = line.match(/^\s*#\s*padd\.excel\.sharing_url\s*=\s*(.*)$/i);
    if (sharingMatch) {
      sharingUrl = trimCell(sharingMatch[1]);
      continue;
    }

    const sheetMatch = line.match(/^\s*#\s*Sheet\s*:\s*(.*)$/i);
    if (sheetMatch) {
      sheetName = trimCell(sheetMatch[1]);
    }
  }

  return { sharingUrl, sheetName };
}

function trimCell(value) {
  return String(value || '').trim();
}

async function askInteractive(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return String(answer || '').trim();
}

async function askMultilineInteractive(question) {
  console.log(question);
  console.log('(finish with an empty line)');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const lines = [];

  return new Promise((resolve) => {
    rl.on('line', (line) => {
      const text = String(line || '');
      if (text.trim() === '') {
        rl.close();
        resolve(lines.join('\n').trim());
        return;
      }
      lines.push(text);
    });
  });
}

function isMissingValue(value) {
  return trimCell(value) === '';
}

function normalizeLinksToBullets(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const lines = raw
    .split(/\r?\n/)
    .flatMap((line) => String(line || '').split(','))
    .map((line) => line.replace(/^\s*-\s*/, '').trim())
    .filter(Boolean);

  if (lines.length === 0) return '';

  return lines
    .map((line) => (line.startsWith('- ') ? line : `- ${line}`))
    .join('\n');
}

function normalizeDurationForDisplay(value) {
  const raw = trimCell(value);
  if (!raw) return '';

  if (/^\d{1,2}:\d{2}:\d{2}$/.test(raw)) {
    const [h, m, s] = raw.split(':').map((part) => Number(part));
    return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  }

  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return raw;
  }

  // Excel time values are stored as day fractions (e.g. 0.0453472 => 01:05:18).
  if (numeric < 1) {
    const totalSeconds = Math.round(numeric * 86400);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
  }

  return raw;
}

function normalizeLinksForPage(linksValue, videoValue) {
  const normalized = normalizeLinksToBullets(linksValue);
  if (!normalized) return '';

  const video = trimCell(videoValue);
  const filtered = normalized
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*-\s*/, '').trim())
    .filter((line) => line !== '' && line !== video)
    .map((line) => `- ${line}`);

  return filtered.join('\n');
}

function parseCsvList(value) {
  return String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function linksArrayFromValue(linksValue, videoValue) {
  const normalized = normalizeLinksForPage(linksValue, videoValue);
  if (!normalized) return [];

  return normalized
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*-\s*/, '').trim())
    .filter(Boolean);
}

function buildTalkTemplateContext(talkRow, talkDate = '') {
  const speakerRaw = trimCell(talkRow['Speaker']);
  const speakers = parseCsvList(speakerRaw);
  const roleRaw = trimCell(talkRow['Role']);
  const roles = parseCsvList(roleRaw);
  const links = linksArrayFromValue(talkRow['Links'], talkRow['Video']);
  const tags = parseCsvList(talkRow['Tags']);

  return {
    number: trimCell(talkRow['Talk #']),
    status: trimCell(talkRow['Status']),
    date: talkDate || trimCell(talkRow['Date']),
    focus: trimCell(talkRow['Focus']),
    title: trimCell(talkRow['Title']),
    description: trimCell(talkRow['Description']),
    speaker: speakerRaw,
    speakers,
    speaker_primary: resolveSpeakerPrimaryValue(speakers.length > 0 ? speakers : speakerRaw),
    hasMultipleSpeakers: speakers.length > 1,
    role: roleRaw,
    roles,
    role_primary: resolveSpeakerPrimaryValue(roles.length > 0 ? roles : roleRaw),
    hasMultipleRoles: roles.length > 1,
    leadManager: trimCell(talkRow['Lead/Manager']),
    account: trimCell(talkRow['Account']),
    tags,
    notes: trimCell(talkRow['Notes']),
    summary: trimCell(talkRow['Summary']),
    video: trimCell(talkRow['Video']),
    duration: normalizeDurationForDisplay(talkRow['Duration']),
    confluence: trimCell(talkRow['Confluence']),
    attendees: trimCell(talkRow['Attendees']),
    links,
    hasLinks: links.length > 0,
  };
}

async function ensurePageRequiredFields(talkRow, options) {
  let changed = false;

  if (options.videoUrl !== null && options.videoUrl !== undefined) {
    const next = trimCell(options.videoUrl);
    if (next !== trimCell(talkRow['Video'])) {
      talkRow['Video'] = next;
      changed = true;
    }
  }

  return { changed };
}

function buildTalkPageBody(talkRow, talkDate) {
  const title = (talkRow['Title'] || '').trim() || 'TBD';
  const summary = trimCell(talkRow['Summary']) || 'TBD';
  const duration = normalizeDurationForDisplay(talkRow['Duration']) || 'TBD';
  const attendees = trimCell(talkRow['Attendees']) || 'TBD';
  const video = trimCell(talkRow['Video']) || 'TBD';
  const links = normalizeLinksForPage(talkRow['Links'], talkRow['Video']);
  const confluenceRef = trimCell(talkRow['Confluence']) || 'TBD';

  return `- Date: ${talkDate}\n`
    + `- Focus: ${(talkRow['Focus'] || '').trim() || 'TBD'}\n`
    + `- Duration: ${duration}\n`
    + `- Speaker: ${(talkRow['Speaker'] || '').trim() || 'TBD'}\n`
    + `- Role: ${(talkRow['Role'] || '').trim() || 'TBD'}\n`
    + `- Attendees: ${attendees}\n\n`
    + '## Description\n\n'
    + `${(talkRow['Description'] || '').trim() || 'TBD'}\n\n`
    + '## Summary\n\n'
    + `${summary}\n\n`
    + '## Resources\n\n'
    + `- Video: ${video}\n`
    + `- Confluence: ${confluenceRef}\n`
    + `- Links: ${links}\n\n`
    + `## Notes\n\n${(talkRow['Notes'] || '').trim() || ''}\n`;
}

function readYamlFile(filePath) {
  return YAML.parse(fs.readFileSync(filePath, 'utf8')) || {};
}

function writeYamlFile(filePath, data) {
  fs.writeFileSync(filePath, YAML.stringify(data), 'utf8');
}

function ensureObject(target, key) {
  if (!target[key] || typeof target[key] !== 'object') {
    target[key] = {};
  }
  return target[key];
}

function buildPageHeaders({ space, parent, title, pageId = '', parentPageId = '' }) {
  const lines = [];
  if (space) lines.push(`<!-- Space: ${space} -->`);
  if (parent) lines.push(`<!-- Parent: ${parent} -->`);
  if (parentPageId) lines.push(`<!-- ParentPageId: ${parentPageId} -->`);
  if (title) lines.push(`<!-- Title: ${title} -->`);
  if (pageId) lines.push(`<!-- PageId: ${pageId} -->`);
  return `${lines.join('\n')}\n\n`;
}

function writeFileIfNeeded(filePath, content, force = false) {
  if (fs.existsSync(filePath) && !force) {
    return false;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function removeFileIfDuplicate(filePath, canonicalPath) {
  if (!fs.existsSync(filePath) || !fs.existsSync(canonicalPath)) {
    return false;
  }

  const left = fs.readFileSync(filePath, 'utf8');
  const right = fs.readFileSync(canonicalPath, 'utf8');
  if (left !== right) {
    return false;
  }

  fs.unlinkSync(filePath);
  return true;
}

function getTalkConfig(coreConfig) {
  return coreConfig?.talk || null;
}

function getWorkspaceRootDir(configPath) {
  return configPath ? path.dirname(configPath) : process.cwd();
}

function pageHeaderValue(content, label) {
  const regex = new RegExp(`<!--\\s*${label}:\\s*(.*?)\\s*-->`, 'i');
  const match = String(content || '').match(regex);
  return match ? String(match[1] || '').trim() : '';
}

function readPageMetadata(filePath) {
  if (!fs.existsSync(filePath)) {
    return { space: '', title: '', parent: '', pageId: '' };
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  return {
    space: pageHeaderValue(raw, 'Space'),
    title: pageHeaderValue(raw, 'Title'),
    parent: pageHeaderValue(raw, 'Parent'),
    pageId: pageHeaderValue(raw, 'PageId'),
  };
}

function inferSeriesTitle(rootDir, seriesKey) {
  const talkDir = path.resolve(rootDir, 'confluence');
  if (!fs.existsSync(talkDir)) {
    return 'Talk Series';
  }

  const suffix = ` - ${seriesKey}.md`;
  const archiveName = `archive - ${seriesKey}.md`;

  const candidates = fs.readdirSync(talkDir)
    .filter((name) => name.endsWith(suffix) && name !== archiveName)
    .sort();

  if (candidates.length > 0) {
    return candidates[0].slice(0, -suffix.length).trim();
  }

  return 'Talk Series';
}

function talkTreeFrom(prefix, seriesTitle, year) {
  const safePrefix = sanitizeFileName(prefix);
  const safeTitle = sanitizeFileName(seriesTitle);
  const rootPage = path.join('confluence', `${safeTitle} - ${safePrefix}.md`);
  const archivePage = path.join('confluence', `archive - ${safePrefix}.md`);
  const archiveDir = path.join('confluence', `archive - ${safePrefix}`);
  const yearBaseName = `${year} - ${safePrefix}`;

  return {
    rootPage,
    archivePage,
    archiveDir,
    yearBaseName,
  };
}

function isDefaultRootStub(content) {
  const title = pageHeaderValue(content, 'Title');
  return title === 'Talk Series' && content.includes('Serie de charlas.');
}

function normalizeSeriesKey(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '');
}

function inferSeriesKey(options, talkConfig = {}) {
  const explicit = normalizeSeriesKey(options.seriesKey || talkConfig.prefix);
  if (explicit) return explicit;

  const fromTitle = options.seriesTitle || '';
  const firstToken = String(fromTitle).trim().split(/\s+/)[0] || '';
  const fromToken = normalizeSeriesKey(firstToken);
  if (fromToken && fromToken.length <= 12) return fromToken;

  return 'TALKS';
}

function resolveCoreConfigForWrite() {
  const existingPath = findCoreConfigPath({ startDir: process.cwd() });
  const configPath = existingPath || path.join(process.cwd(), '.padd.yaml');
  const config = existingPath ? readYamlFile(existingPath) : {};
  return { configPath, config };
}

function resolveAnnouncementsTemplatePath(rootDir) {
  const templatePath = path.resolve(rootDir, '.tmpl.message.md');
  if (fs.existsSync(templatePath)) {
    return templatePath;
  }

  return null;
}

function resolvePageTemplatePath(rootDir) {
  const templatePath = path.resolve(rootDir, '.tmpl.page.md');
  if (fs.existsSync(templatePath)) {
    return templatePath;
  }

  return null;
}

function computeTemplateVars(talkRow, options, coreConfig) {
  const talkNum = Number(talkRow['Talk #'] || 0);
  const date = String(talkRow['Date'] || '').trim();
  const year = date ? Number(date.slice(0, 4)) : new Date().getFullYear();
  const season = String(year).slice(-2);
  const episode = talkNum > 0 ? pad2(talkNum) : '??';

  const seasonEpisode = `S${season}E${episode}`;
  const title = (talkRow['Title'] || '').trim() || 'TBD';
  const description = (talkRow['Description'] || '').trim() || 'Sin descripción.';
  const speaker = (talkRow['Speaker'] || '').trim() || 'TBD';
  const speakerList = parseCsvList(speaker);
  const speakerPrimary = resolveSpeakerPrimaryValue(speakerList.length > 0 ? speakerList : speaker) || speaker;
  const role = (talkRow['Role'] || '').trim() || 'TBD';
  const roleList = parseCsvList(role);
  const rolePrimary = resolveSpeakerPrimaryValue(roleList.length > 0 ? roleList : role) || role;
  const account = (talkRow['Account'] || '').trim();
  const titleUrlEncoded = encodeURIComponent(title);

  const time = options.time || '12:05 PM';
  const talkPrefix = String(
    coreConfig?.talk?.prefix
    || 'TALK'
  ).trim();
  const feedbackTitle = `${talkPrefix} ${seasonEpisode} | ${title}`;
  const feedbackTitleUrlEncoded = encodeURIComponent(feedbackTitle);
  const dayName = formatDayName(date, false);
  const dayNameLower = formatDayName(date, true);
  const formattedDate = formatDateLong(date);
  const accountLabel = account ? ` - ${account}` : '';

  const prefiledLinkTemplate = trimCell(
    coreConfig?.talk?.prefiledlink
      || coreConfig?.talk?.prefilledlink
      || coreConfig?.talk?.feedback_url_format
      || coreConfig?.talk?.feedback_url
  );

  const prefiledLink = prefiledLinkTemplate
    ? renderTemplate(prefiledLinkTemplate, {
      talk: {
        prefix: talkPrefix,
        season_episode: seasonEpisode,
        title,
        feedback_title: feedbackTitle,
        feedback_title_urlencoded: feedbackTitleUrlEncoded,
      },
      talk_prefix: talkPrefix,
      season_episode: seasonEpisode,
      title,
      feedback_title: feedbackTitle,
      feedback_title_urlencoded: feedbackTitleUrlEncoded,
    }).trim()
    : '';

  let feedbackUrlFromPrefilled = prefiledLink
    .replace(/NOMBREDELACHARLA/g, feedbackTitleUrlEncoded)
    .replace(/__PADD_FEEDBACK_TITLE__/g, feedbackTitleUrlEncoded);
  if (feedbackUrlFromPrefilled === prefiledLink && /[?&][^=&]+=$/.test(feedbackUrlFromPrefilled)) {
    feedbackUrlFromPrefilled += feedbackTitleUrlEncoded;
  }

  const feedbackUrl = options.feedbackUrl
    || feedbackUrlFromPrefilled
    || `[REPLACE_FEEDBACK_FORM_URL]?talk_title=${feedbackTitleUrlEncoded}`;

  const talkContext = {
    ...buildTalkTemplateContext(talkRow, date),
    prefix: talkPrefix,
    season_episode: seasonEpisode,
    seasonEpisode,
    day_name: dayName,
    day_name_lower: dayNameLower,
    formatted_date: formattedDate,
    time,
    prefiledlink: prefiledLink,
    feedback_title: feedbackTitle,
    feedback_title_urlencoded: feedbackTitleUrlEncoded,
    speaker_first: speakerPrimary,
    speaker_primary: speakerPrimary,
    speakerPrimary,
    title_urlencoded: titleUrlEncoded,
    roles: roleList,
    role_primary: rolePrimary,
    account_label: accountLabel,
    feedback_url: feedbackUrl,
  };

  return {
    TalkPrefix: talkPrefix,
    SeasonEpisode: seasonEpisode,
    DayName: dayName,
    dayName: dayNameLower,
    FormattedDate: formattedDate,
    Time: time,
    Title: title,
    Description: description,
    Speaker: speaker,
    Role: rolePrimary,
    RolePrimary: rolePrimary,
    Account: accountLabel,
    FeedbackUrl: feedbackUrl,
    talk_prefix: talkPrefix,
    season_episode: seasonEpisode,
    day_name: dayName,
    day_name_lower: dayNameLower,
    formatted_date: formattedDate,
    time,
    prefiledlink: prefiledLink,
    feedback_title: feedbackTitle,
    feedback_title_urlencoded: feedbackTitleUrlEncoded,
    title,
    title_urlencoded: titleUrlEncoded,
    description,
    speaker,
    speaker_first: speakerPrimary,
    speaker_primary: speakerPrimary,
    role,
    roles: roleList,
    role_primary: rolePrimary,
    account,
    account_label: accountLabel,
    feedback_url: feedbackUrl,
    talk: talkContext,
  };
}

function renderTemplate(templateText, vars) {
  if (!renderTemplate.env) {
    const env = new nunjucks.Environment(undefined, {
      autoescape: false,
      throwOnUndefined: false,
      trimBlocks: true,
      lstripBlocks: true,
    });
    env.addFilter('urlencode', (value) => encodeURIComponent(String(value ?? '')));
    renderTemplate.env = env;
  }

  return renderTemplate.env.renderString(templateText, vars);
}

function buildDefaultAnnouncements(vars) {
  return `# Announcements\n\n## Save the date\n\nSubject: 📅 ${vars.TalkPrefix} ${vars.SeasonEpisode} — ${vars.Title}\n\n${vars.TalkPrefix} ${vars.SeasonEpisode} — ${vars.Title}\n\n${vars.DayName} ${vars.FormattedDate} - ${vars.Time} - Anotalo en tu agenda\n\n- Speaker: ${vars.Speaker} (${vars.Role}${vars.Account})\n\n${vars.Description}\n\n---\n\n## Last call\n\nSubject: 🚀 Hoy a las ${vars.Time}: ${vars.Title} — ${vars.TalkPrefix} ${vars.SeasonEpisode}\n\nHoy - ${vars.Time} - No te lo pierdas\n\n- Speaker: ${vars.Speaker} (${vars.Role}${vars.Account})\n\n${vars.Description}\n\n---\n\n## Post-talk\n\nSubject: 💬 Tu feedback sobre ${vars.TalkPrefix} ${vars.SeasonEpisode}\n\nGracias por participar en la charla.\n\nFeedback: ${vars.FeedbackUrl}\n`;
}

function buildAnnouncementsTemplate() {
  return '# Announcements\n\n'
    + '## Save the date\n\n'
    + 'Subject: 📅 {{ talk.prefix }} {{ talk.season_episode }} — {{ talk.title }}\n\n'
    + '{{ talk.prefix }} {{ talk.season_episode }} — {{ talk.title }}\n\n'
    + '{{ talk.day_name }} {{ talk.formatted_date }} - {{ talk.time }} - Anotalo en tu agenda\n\n'
    + '{% if talk.hasMultipleSpeakers %}\n'
    + '- Speakers:\n'
    + '{% for speaker in talk.speakers %}\n'
    + '  - {{ speaker }}{% if (talk.roles and talk.roles[loop.index0]) or talk.role_primary or talk.role %} ({{ (talk.roles and talk.roles[loop.index0]) or talk.role_primary or talk.role }}{{ talk.account_label }}){% endif %}\n'
    + '{% endfor %}\n'
    + '{% else %}\n'
    + '- Speaker: {{ talk.speaker_primary }}{% if talk.role_primary or talk.role %} ({{ talk.role_primary or talk.role }}{{ talk.account_label }}){% endif %}\n'
    + '{% endif %}\n\n'
    + '{{ talk.description }}\n\n'
    + '---\n\n'
    + '## Last call\n\n'
    + 'Subject: 🚀 Hoy a las {{ talk.time }}: {{ talk.title }} — {{ talk.prefix }} {{ talk.season_episode }}\n\n'
    + 'Hoy - {{ talk.time }} - No te lo pierdas\n\n'
    + '{% if talk.hasMultipleSpeakers %}\n'
    + '- Speakers:\n'
    + '{% for speaker in talk.speakers %}\n'
    + '  - {{ speaker }}{% if (talk.roles and talk.roles[loop.index0]) or talk.role_primary or talk.role %} ({{ (talk.roles and talk.roles[loop.index0]) or talk.role_primary or talk.role }}{{ talk.account_label }}){% endif %}\n'
    + '{% endfor %}\n'
    + '{% else %}\n'
    + '- Speaker: {{ talk.speaker_primary }}{% if talk.role_primary or talk.role %} ({{ talk.role_primary or talk.role }}{{ talk.account_label }}){% endif %}\n'
    + '{% endif %}\n\n'
    + '{{ talk.description }}\n\n'
    + '---\n\n'
    + '## Post-talk\n\n'
    + 'Subject: 💬 Tu feedback sobre {{ talk.prefix }} {{ talk.season_episode }}\n\n'
    + 'Gracias por participar en la charla.\n\n'
    + '{% if talk.prefiledlink %}\n'
    + 'Feedback: {{ talk.prefiledlink }}{{ talk.feedback_title | urlencode }}\n'
    + '{% else %}\n'
    + 'Feedback: {{ talk.feedback_url }}\n'
    + '{% endif %}\n';
}

function buildPageTemplate() {
  return '## Metadata\n\n'
    + '| Field | Value |\n'
    + '| --- | --- |\n'
    + '| Date | {{ talk.date }} |\n'
    + '| Focus | {{ talk.focus }} |\n'
    + '{% if talk.duration %}| Duration | {{ talk.duration }} |\n'
    + '{% endif %}{% if talk.attendees %}| Attendees | {{ talk.attendees }} |\n'
    + '{% endif %}\n\n'
    + '## {% if talk.hasMultipleSpeakers %}Speakers{% else %}Speaker{% endif %}\n\n'
    + '{% for speaker in talk.speakers %}\n'
    + '- {{ speaker }}{% if (talk.roles and talk.roles[loop.index0]) or talk.role_primary or talk.role %} ({{ (talk.roles and talk.roles[loop.index0]) or talk.role_primary or talk.role }}){% endif %}\n'
    + '{% endfor %}\n\n'
    + '{% if talk.summary %}\n'
    + '## Summary\n\n'
    + '{{ talk.summary }}\n'
    + '{% endif %}\n\n'
    + '{% if talk.video %}\n'
    + '## Video\n\n'
    + '- [{{ talk.prefix }} {{ talk.season_episode }} | {{ talk.title }} by {{ talk.speaker_primary }}{% if talk.duration %} ({{ talk.duration }}){% endif %}]({{ talk.video }})\n'
    + '{% endif %}\n\n'
    + '{% if talk.hasLinks %}\n'
    + '## Related Links\n\n'
    + 'Additional resources mentioned during the talk:\n\n'
    + '{%- for link in talk.links %}\n'
    + '- {{ link }}\n'
    + '{%- endfor %}\n'
    + '{% endif %}\n\n'
    + '{% if talk.notes %}\n'
    + '## Notes\n\n'
    + 'Operational notes and follow-ups:\n\n'
    + '{{ talk.notes }}\n'
    + '{% endif %}\n';
}

function buildGenericPageBody(talkRow, talkDate) {
  return `- Date: ${talkDate}\n`
    + `- Focus: ${(talkRow['Focus'] || '').trim() || 'TBD'}\n`
    + `- Duration: ${trimCell(talkRow['Duration']) || 'TBD'}\n`
    + `- Speaker: ${(talkRow['Speaker'] || '').trim() || 'TBD'}\n`
    + `- Role: ${(talkRow['Role'] || '').trim() || 'TBD'}\n`
    + `- Attendees: ${trimCell(talkRow['Attendees']) || 'TBD'}\n\n`
    + '## Summary\n\n'
    + `${trimCell(talkRow['Summary']) || 'Sin summary cargado.'}\n\n`
    + '## Video\n\n'
    + `${trimCell(talkRow['Video']) || 'Sin video cargado.'}\n\n`
    + '## Notes\n\n'
    + 'Completar contenido de la charla si hace falta.\n';
}

async function initCommand(options) {
  const year = String(options.year || new Date().getFullYear());
  const { configPath, config } = resolveCoreConfigForWrite();
  const rootDir = getWorkspaceRootDir(configPath);

  const sharepoint = ensureObject(config, 'sharepoint');
  const confluence = ensureObject(config, 'confluence');
  const talk = ensureObject(config, 'talk');
  const talkVideoArchive = ensureObject(talk, 'video_archive');
  const legacyTalkConfluence = talk?.confluence && typeof talk.confluence === 'object'
    ? talk.confluence
    : null;
  const legacyExcelSharingUrl = trimCell(talk?.excel_sharing_url);
  const legacyExcelSheetName = trimCell(talk?.excel_sheet_name);
  const legacyConfluenceTalk = confluence?.talk && typeof confluence.talk === 'object'
    ? confluence.talk
    : null;
  const legacyTalkSharepointArchive = talk?.sharepoint?.video_archive && typeof talk.sharepoint.video_archive === 'object'
    ? talk.sharepoint.video_archive
    : null;
  const legacyVideoArchive = config?.sharepoint?.talk?.video_archive && typeof config.sharepoint.talk.video_archive === 'object'
    ? config.sharepoint.talk.video_archive
    : null;

  if (!isConfiguredValue(confluence.space) && isConfiguredValue(legacyTalkConfluence?.space)) {
    confluence.space = legacyTalkConfluence.space;
  }
  if (!isConfiguredValue(confluence.space) && isConfiguredValue(legacyConfluenceTalk?.space)) {
    confluence.space = legacyConfluenceTalk.space;
  }
  if (!isConfiguredValue(confluence.root_page_id) && isConfiguredValue(legacyTalkConfluence?.root_page_id)) {
    confluence.root_page_id = legacyTalkConfluence.root_page_id;
  }
  if (!isConfiguredValue(confluence.root_page_id) && isConfiguredValue(legacyTalkConfluence?.parent_page_id)) {
    confluence.root_page_id = legacyTalkConfluence.parent_page_id;
  }
  if (!isConfiguredValue(confluence.root_page_id) && isConfiguredValue(legacyConfluenceTalk?.root_page_id)) {
    confluence.root_page_id = legacyConfluenceTalk.root_page_id;
  }
  if (!isConfiguredValue(confluence.root_page_id) && isConfiguredValue(legacyConfluenceTalk?.parent_page_id)) {
    confluence.root_page_id = legacyConfluenceTalk.parent_page_id;
  }
  if (!isConfiguredValue(confluence.root_page_id) && isConfiguredValue(confluence.root_page)) {
    confluence.root_page_id = confluence.root_page;
  }

  if (!isConfiguredValue(confluence.base_url)) {
    confluence.base_url = 'https://confluence.uhub.biz';
  }

  if (!isConfiguredValue(talk.video_archive_url) && isConfiguredValue(legacyTalkSharepointArchive?.url)) {
    talk.video_archive_url = legacyTalkSharepointArchive.url;
  }
  if (!isConfiguredValue(talk.video_archive_url) && isConfiguredValue(legacyTalkSharepointArchive?.share_url)) {
    talk.video_archive_url = legacyTalkSharepointArchive.share_url;
  }
  if (!isConfiguredValue(talk.video_archive_url) && isConfiguredValue(legacyVideoArchive?.url)) {
    talk.video_archive_url = legacyVideoArchive.url;
  }
  if (!isConfiguredValue(talk.video_archive_url) && isConfiguredValue(legacyVideoArchive?.share_url)) {
    talk.video_archive_url = legacyVideoArchive.share_url;
  }
  if (!isConfiguredValue(talkVideoArchive.site_id) && isConfiguredValue(legacyTalkSharepointArchive?.site_id)) {
    talkVideoArchive.site_id = legacyTalkSharepointArchive.site_id;
  }
  if (!isConfiguredValue(talkVideoArchive.site_id) && isConfiguredValue(legacyVideoArchive?.site_id)) {
    talkVideoArchive.site_id = legacyVideoArchive.site_id;
  }
  if (!isConfiguredValue(talkVideoArchive.drive_id) && isConfiguredValue(legacyTalkSharepointArchive?.drive_id)) {
    talkVideoArchive.drive_id = legacyTalkSharepointArchive.drive_id;
  }
  if (!isConfiguredValue(talkVideoArchive.drive_id) && isConfiguredValue(legacyVideoArchive?.drive_id)) {
    talkVideoArchive.drive_id = legacyVideoArchive.drive_id;
  }
  if (!isConfiguredValue(talkVideoArchive.folder_id) && isConfiguredValue(legacyTalkSharepointArchive?.folder_id)) {
    talkVideoArchive.folder_id = legacyTalkSharepointArchive.folder_id;
  }
  if (!isConfiguredValue(talkVideoArchive.folder_id) && isConfiguredValue(legacyTalkSharepointArchive?.archive_parent_id)) {
    talkVideoArchive.folder_id = legacyTalkSharepointArchive.archive_parent_id;
  }
  if (!isConfiguredValue(talkVideoArchive.folder_id) && isConfiguredValue(legacyVideoArchive?.folder_id)) {
    talkVideoArchive.folder_id = legacyVideoArchive.folder_id;
  }
  if (!isConfiguredValue(talkVideoArchive.folder_id) && isConfiguredValue(legacyVideoArchive?.archive_parent_id)) {
    talkVideoArchive.folder_id = legacyVideoArchive.archive_parent_id;
  }

  if (!isConfiguredValue(talk.video_filename_format) && isConfiguredValue(legacyTalkSharepointArchive?.filename_format)) {
    talk.video_filename_format = legacyTalkSharepointArchive.filename_format;
  }
  if (!isConfiguredValue(talk.video_filename_format) && isConfiguredValue(legacyVideoArchive?.filename_format)) {
    talk.video_filename_format = legacyVideoArchive.filename_format;
  }
  if (!isConfiguredValue(talk.video_title_format) && isConfiguredValue(legacyTalkSharepointArchive?.title_format)) {
    talk.video_title_format = legacyTalkSharepointArchive.title_format;
  }
  if (!isConfiguredValue(talk.video_title_format) && isConfiguredValue(legacyVideoArchive?.title_format)) {
    talk.video_title_format = legacyVideoArchive.title_format;
  }
  const seriesKey = inferSeriesKey(options, talk);
  if (!seriesKey || seriesKey === 'TALKS') {
    if (!options.noPrompt) {
      const response = await askInteractive('Talk prefix / series key (required, e.g. WSSC): ');
      if (response) {
        options.seriesKey = response;
      }
    }
  }

  const resolvedSeriesKey = inferSeriesKey(options, talk);
  if (!resolvedSeriesKey || resolvedSeriesKey === 'TALKS') {
    throw new Error('Missing series key. Use --series-key <KEY> (for example WSSC).');
  }

  if (!options.seriesTitle && !options.noPrompt) {
    const inferredTitle = inferSeriesTitle(rootDir, resolvedSeriesKey);
    if (!inferredTitle || inferredTitle === 'Talk Series') {
      const response = await askInteractive('Talk full title (required, e.g. Wanna See Something Cool): ');
      if (response) {
        options.seriesTitle = response;
      }
    }
  }

  const seriesTitle = options.seriesTitle || inferSeriesTitle(rootDir, resolvedSeriesKey);
  const tree = talkTreeFrom(resolvedSeriesKey, seriesTitle || 'Talk Series', year);
  const talksCsvPath = path.resolve(rootDir, `talks_${year}.csv`);
  const existingExcelSeed = readExcelMetadataComments(talksCsvPath);
  const existingExcelSharingUrl = legacyExcelSharingUrl || existingExcelSeed.sharingUrl;
  const existingExcelSheetName = legacyExcelSheetName || existingExcelSeed.sheetName;

  if (!options.space && !confluence.space && !options.noPrompt) {
    const response = await askInteractive('Confluence space key (optional, enter to skip): ');
    if (response) {
      options.space = response;
    }
  }

  if (!options.parentPageId && !confluence.root_page_id && !options.noPrompt) {
    const shouldAskParent = Boolean(options.space || confluence.space);
    if (shouldAskParent) {
      const response = await askInteractive('Confluence root page id (optional, enter to skip): ');
      if (response) {
        options.parentPageId = response;
      }
    }
  }

  if (!options.videoArchiveUrl && !talk.video_archive_url && !options.noPrompt) {
    const response = await askInteractive('SharePoint archive root folder URL for videos (optional, enter to skip): ');
    if (response) {
      options.videoArchiveUrl = response;
    }
  }

  if (!options.excelSharingUrl && !existingExcelSharingUrl && !options.noPrompt) {
    const response = await askInteractive('SharePoint Excel sharing URL for schedule sync (optional, enter to skip): ');
    if (response) {
      options.excelSharingUrl = response;
    }
  }

  if (!options.excelSheetName && !existingExcelSheetName && !options.noPrompt) {
    const shouldAskSheet = Boolean(options.excelSharingUrl || existingExcelSharingUrl);
    if (shouldAskSheet) {
      const response = await askInteractive('Excel sheet name for schedule sync [default: Schedule]: ');
      if (response) {
        options.excelSheetName = response;
      }
    }
  }

  const rootFilePath = path.resolve(rootDir, tree.rootPage);
  const legacyRootCandidates = [
    path.resolve(rootDir, sanitizeFileName(`Talk Series - ${resolvedSeriesKey}.md`)),
    path.resolve(rootDir, path.join('confluence', sanitizeFileName(`Talk Series - ${resolvedSeriesKey}.md`))),
  ];
  const archiveFilePath = path.resolve(rootDir, tree.archivePage);
  const yearFilePath = path.resolve(rootDir, path.join(tree.archiveDir, `${tree.yearBaseName}.md`));
  const yearDirPath = path.resolve(rootDir, path.join(tree.archiveDir, tree.yearBaseName));
  const messageTemplatePath = path.resolve(rootDir, '.tmpl.message.md');
  const pageTemplatePath = path.resolve(rootDir, '.tmpl.page.md');
  const legacySchedulePath = path.resolve(rootDir, 'schedule.csv');

  const existingRoot = readPageMetadata(rootFilePath);
  const existingArchive = readPageMetadata(archiveFilePath);
  const existingYear = readPageMetadata(yearFilePath);

  const space = options.space
    || confluence.space
    || existingRoot.space
    || existingArchive.space
    || existingYear.space
    || '';
  const rootPageId = options.parentPageId || confluence.root_page_id || confluence.root_page || '';
  const archiveTitle = `Archive - ${resolvedSeriesKey}`;
  const confluenceEnabled = isConfiguredValue(space) && isConfiguredValue(rootPageId);

  if (options.videoArchiveUrl) {
    talk.video_archive_url = options.videoArchiveUrl;
    delete talkVideoArchive.site_id;
    delete talkVideoArchive.drive_id;
    delete talkVideoArchive.folder_id;
  } else if (!isConfiguredValue(talk.video_archive_url)) {
    delete talk.video_archive_url;
  }

  if (talk.video_archive) {
    delete talk.video_archive.url;
    delete talk.video_archive.share_url;
    delete talk.video_archive.archive_parent_id;
    if (Object.keys(talk.video_archive).length === 0) {
      delete talk.video_archive;
    }
  }

  if (!isConfiguredValue(talk.video_filename_format)) {
    talk.video_filename_format = '{{ talk.prefix }}_{{ talk.season_episode }}__{{ talk.title }}__{{ talk.speaker_primary }}';
  }
  if (!isConfiguredValue(talk.video_title_format)) {
    talk.video_title_format = '{{ talk.prefix }} {{ talk.season_episode }} | {{ talk.title }} by {{ talk.speaker_primary }}';
  }

  const excelSharingUrl = options.excelSharingUrl || existingExcelSharingUrl || '';
  const excelSheetName = options.excelSheetName || existingExcelSheetName || (excelSharingUrl ? 'Schedule' : '');

  let removedLegacyRoot = '';
  for (const legacyRootFilePath of legacyRootCandidates) {
    if (rootFilePath === legacyRootFilePath || !fs.existsSync(legacyRootFilePath)) {
      continue;
    }

    const legacyContent = fs.readFileSync(legacyRootFilePath, 'utf8');
    if (!fs.existsSync(rootFilePath)) {
      fs.mkdirSync(path.dirname(rootFilePath), { recursive: true });
      fs.renameSync(legacyRootFilePath, rootFilePath);
    } else if (isDefaultRootStub(legacyContent)) {
      fs.unlinkSync(legacyRootFilePath);
      removedLegacyRoot = legacyRootFilePath;
    }
    break;
  }

  talk.prefix = resolvedSeriesKey;
  if (!isConfiguredValue(talk.page_title_format)) {
    talk.page_title_format = '{{ talk.prefix }} {{ talk.season_episode }} | {{ talk.title }} by {{ talk.speaker_primary }}';
  }
  if (confluenceEnabled) {
    confluence.space = space;
    confluence.root_page_id = rootPageId;
  }
  delete talk.paths;
  delete talk.announcements;
  delete talk.confluence_sync;
  delete talk.confluence;
  delete talk.sharepoint;
  delete talk.excel_sharing_url;
  delete talk.excel_sheet_name;
  delete confluence.talk;
  delete confluence.root_page;
  delete sharepoint.talk;

  normalizeIntegrationTokenConfig(config);
  writeYamlFile(configPath, config);
  appendInlineTokenPlaceholders(configPath, config);

  let createdRoot = false;
  let createdArchive = false;
  let createdYear = false;
  if (confluenceEnabled) {
    const rootContent =
      buildPageHeaders({
        space,
        parentPageId: rootPageId,
        title: seriesTitle,
        pageId: existingRoot.pageId || '',
      }) +
      `${seriesTitle}\n${'='.repeat(seriesTitle.length)}\n\n` +
      'Serie de charlas.\n';

    const archiveContent =
      buildPageHeaders({
        space,
        parent: seriesTitle,
        title: archiveTitle,
        pageId: existingArchive.pageId || '',
      }) +
      `${archiveTitle}\n${'='.repeat(archiveTitle.length)}\n\n` +
      'Archivo de charlas por año.\n';

    const yearTitle = tree.yearBaseName;
    const yearContent =
      buildPageHeaders({
        space,
        parent: archiveTitle,
        title: yearTitle,
        pageId: existingYear.pageId || '',
      }) +
      `${yearTitle}\n${'='.repeat(yearTitle.length)}\n\n` +
      'Charlas del año.\n';

    createdRoot = writeFileIfNeeded(rootFilePath, rootContent, options.force);
    createdArchive = writeFileIfNeeded(archiveFilePath, archiveContent, options.force);
    createdYear = writeFileIfNeeded(yearFilePath, yearContent, options.force);
    fs.mkdirSync(yearDirPath, { recursive: true });
  }
  const createdMessageTemplate = writeFileIfNeeded(messageTemplatePath, buildAnnouncementsTemplate(), false);
  const createdPageTemplate = writeFileIfNeeded(pageTemplatePath, buildPageTemplate(), false);

  let excelSeededInCsv = false;
  let createdTalksCsv = false;
  if (!fs.existsSync(talksCsvPath)) {
    if (fs.existsSync(legacySchedulePath)) {
      fs.copyFileSync(legacySchedulePath, talksCsvPath);
    } else {
      fs.writeFileSync(talksCsvPath, `${TALKS_CSV_HEADERS.join(',')}\n`, 'utf8');
    }
    createdTalksCsv = true;
  }
  excelSeededInCsv = seedExcelMetadataComments(talksCsvPath, {
    sharingUrl: excelSharingUrl,
    sheetName: excelSheetName,
  });

  const relConfig = path.relative(rootDir, configPath) || configPath;
  const relRoot = path.relative(rootDir, rootFilePath) || rootFilePath;
  const relArchive = path.relative(rootDir, archiveFilePath) || archiveFilePath;
  const relYear = path.relative(rootDir, yearFilePath) || yearFilePath;
  const relMessageTemplate = path.relative(rootDir, messageTemplatePath) || messageTemplatePath;
  const relPageTemplate = path.relative(rootDir, pageTemplatePath) || pageTemplatePath;
  const relTalksCsv = path.relative(rootDir, talksCsvPath) || talksCsvPath;

  const legacyRootDuplicate = path.resolve(rootDir, path.basename(rootFilePath));
  const legacyArchiveDuplicate = path.resolve(rootDir, path.basename(archiveFilePath));
  const legacyYearDuplicate = path.resolve(
    rootDir,
    path.join(path.basename(path.dirname(yearFilePath)), path.basename(yearFilePath))
  );
  const removedLegacyDuplicates = [];
  const movedLegacyArtifacts = [];

  if (confluenceEnabled) {
    if (removeFileIfDuplicate(legacyRootDuplicate, rootFilePath)) {
      removedLegacyDuplicates.push(path.relative(rootDir, legacyRootDuplicate) || legacyRootDuplicate);
    }
    if (removeFileIfDuplicate(legacyArchiveDuplicate, archiveFilePath)) {
      removedLegacyDuplicates.push(path.relative(rootDir, legacyArchiveDuplicate) || legacyArchiveDuplicate);
    }
    if (removeFileIfDuplicate(legacyYearDuplicate, yearFilePath)) {
      removedLegacyDuplicates.push(path.relative(rootDir, legacyYearDuplicate) || legacyYearDuplicate);
    }
  }

  const legacyArchiveDirDuplicate = path.resolve(rootDir, path.basename(path.dirname(yearFilePath)));
  if (confluenceEnabled && fs.existsSync(legacyArchiveDirDuplicate)) {
    const remaining = fs.readdirSync(legacyArchiveDirDuplicate);
    if (remaining.length === 0) {
      fs.rmdirSync(legacyArchiveDirDuplicate);
      removedLegacyDuplicates.push(path.relative(rootDir, legacyArchiveDirDuplicate) || legacyArchiveDirDuplicate);
    }
  }

  const migrationDir = path.resolve(rootDir, '_legacy_talk_migration');
  const moveLegacyIfExists = (legacyPath) => {
    if (!fs.existsSync(legacyPath)) return;
    fs.mkdirSync(migrationDir, { recursive: true });
    const base = path.basename(legacyPath);
    const target = path.resolve(migrationDir, base);
    if (fs.existsSync(target)) return;
    fs.renameSync(legacyPath, target);
    movedLegacyArtifacts.push(`${path.relative(rootDir, legacyPath) || legacyPath} -> ${path.relative(rootDir, target) || target}`);
  };

  if (confluenceEnabled) {
    moveLegacyIfExists(legacyYearDuplicate);
    moveLegacyIfExists(legacyArchiveDuplicate);
    moveLegacyIfExists(legacyRootDuplicate);
  }

  if (confluenceEnabled && fs.existsSync(legacyArchiveDirDuplicate)) {
    const remaining = fs.readdirSync(legacyArchiveDirDuplicate);
    if (remaining.length === 0) {
      fs.rmdirSync(legacyArchiveDirDuplicate);
      removedLegacyDuplicates.push(path.relative(rootDir, legacyArchiveDirDuplicate) || legacyArchiveDirDuplicate);
    } else {
      fs.mkdirSync(migrationDir, { recursive: true });
      const dirTarget = path.resolve(migrationDir, `${path.basename(legacyArchiveDirDuplicate)}__dir`);
      if (!fs.existsSync(dirTarget)) {
        fs.renameSync(legacyArchiveDirDuplicate, dirTarget);
        movedLegacyArtifacts.push(`${path.relative(rootDir, legacyArchiveDirDuplicate) || legacyArchiveDirDuplicate} -> ${path.relative(rootDir, dirTarget) || dirTarget}`);
      }
    }
  }

  console.log(`✓ updated ${relConfig}`);
  if (confluenceEnabled) {
    console.log(`✓ ${createdRoot ? 'created' : 'exists'} ${relRoot}`);
    console.log(`✓ ${createdArchive ? 'created' : 'exists'} ${relArchive}`);
    console.log(`✓ ${createdYear ? 'created' : 'exists'} ${relYear}`);
  } else {
    console.log('! skipped confluence tree generation (confluence.space/root_page_id not configured)');
  }
  console.log(`✓ ${createdMessageTemplate ? 'created' : 'exists'} ${relMessageTemplate}`);
  console.log(`✓ ${createdPageTemplate ? 'created' : 'exists'} ${relPageTemplate}`);
  console.log(`✓ ${createdTalksCsv ? 'created' : 'exists'} ${relTalksCsv}`);
  if (removedLegacyRoot) {
    const relLegacy = path.relative(rootDir, removedLegacyRoot) || removedLegacyRoot;
    console.log(`✓ removed legacy ${relLegacy}`);
  }
  for (const relDuplicate of removedLegacyDuplicates) {
    console.log(`✓ removed legacy ${relDuplicate}`);
  }
  for (const relMoved of movedLegacyArtifacts) {
    console.log(`✓ moved legacy ${relMoved}`);
  }
  if (isConfiguredValue(talk.video_archive_url)) {
    console.log('! sharepoint video archive URL saved; talk video will resolve IDs on first successful run');
  } else {
    console.log('! sharepoint video archive not configured (talk video will keep provided URL as-is)');
  }
  if (excelSeededInCsv) {
    console.log(`! excel seed metadata written in ${relTalksCsv} comments (sharing_url + sheet)`);
  }
  console.log(`✓ ready talks root: ${seriesTitle}`);
}

async function announcementsCommand(options) {
  const { configPath, config: coreConfig } = loadCoreConfig({ startDir: process.cwd(), required: false });
  const rootDir = getWorkspaceRootDir(configPath);
  const schedulePath = resolveSchedulePath(options.schedulePath, rootDir, options);
  if (!fs.existsSync(schedulePath)) {
    throw new Error(`Schedule file not found: ${schedulePath}`);
  }

  const csv = readCsvWithoutComments(schedulePath);
  const rows = csvToObjects(csv);
  if (rows.length === 0) {
    throw new Error('Schedule CSV is empty or invalid');
  }

  const talkRow = findTalkRow(rows, options);
  if (!talkRow) {
    throw new Error('No talk row found with provided selector (--talk/--date)');
  }

  const vars = computeTemplateVars(talkRow, options, coreConfig);

  const templatePath = resolveAnnouncementsTemplatePath(rootDir);
  const content = templatePath && fs.existsSync(templatePath)
    ? renderTemplate(fs.readFileSync(templatePath, 'utf8'), vars)
    : buildDefaultAnnouncements(vars);

  const outPath = path.resolve(
    rootDir,
    options.outPath || defaultOutputPath(talkRow)
  );

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, content, 'utf8');

  const rel = path.relative(process.cwd(), outPath) || outPath;
  const talkRef = talkRow['Talk #'] || '?';
  console.log(`✓ generated ${rel} (talk ${talkRef})`);
}

async function createCommand(options) {
  const { configPath, config: coreConfig } = loadCoreConfig({ startDir: process.cwd(), required: true });
  const rootDir = getWorkspaceRootDir(configPath);
  const schedulePath = resolveSchedulePath(options.schedulePath, rootDir, options);
  if (!fs.existsSync(schedulePath)) {
    throw new Error(`Schedule file not found: ${schedulePath}`);
  }

  const talkConfig = getTalkConfig(coreConfig);
  if (!talkConfig?.prefix) {
    throw new Error('Missing talk.prefix in .padd.yaml. Run: padd talk init');
  }

  if (!isConfluenceConfigured(coreConfig)) {
    console.log('! skipped: confluence.space/root_page_id not configured in .padd.yaml');
    return;
  }

  const suffix = String(talkConfig.prefix || 'TALK').trim();
  const seriesTitle = inferSeriesTitle(rootDir, suffix);
  const tree = talkTreeFrom(suffix, seriesTitle, new Date().getFullYear());

  const scheduleData = readScheduleWithComments(schedulePath);
  if (scheduleData.rows.length === 0) {
    throw new Error('Schedule CSV is empty or invalid');
  }

  const rows = scheduleData.rows;
  const scheduleHeaders = ensureColumns(rows, scheduleData.headers, ['Summary', 'Video', 'Confluence', 'Attendees']);
  const talkRow = findTalkRow(rows, options);
  if (!talkRow) {
    throw new Error('No talk row found with provided selector (--talk/--date)');
  }

  const required = await ensurePageRequiredFields(talkRow, options);

  if (required.changed) {
    writeScheduleWithComments(schedulePath, scheduleData.comments, rows, scheduleHeaders);
    const relSchedule = path.relative(process.cwd(), schedulePath) || schedulePath;
    console.log(`✓ updated ${relSchedule}`);
  }

  const talkDate = String(talkRow['Date'] || '').trim();
  if (!talkDate) {
    throw new Error('Selected talk has no Date value in schedule.csv');
  }

  const year = talkDate.slice(0, 4);
  const yearBaseName = sanitizeFileName(`${year} - ${suffix}`);
  const yearDirPath = path.resolve(rootDir, path.join(tree.archiveDir, yearBaseName));
  fs.mkdirSync(yearDirPath, { recursive: true });

  const pageTitle = computeTalkContentTitle(talkRow, talkConfig);
  const fileName = `${sanitizeFileName(pageTitle)}.md`;
  const outputPath = path.resolve(yearDirPath, fileName);

  const rootMeta = readPageMetadata(path.resolve(rootDir, tree.rootPage));
  const archiveMeta = readPageMetadata(path.resolve(rootDir, tree.archivePage));
  const yearMeta = readPageMetadata(path.resolve(rootDir, path.join(tree.archiveDir, `${yearBaseName}.md`)));
  const pageSpace = yearMeta.space || archiveMeta.space || rootMeta.space || 'REPLACE_SPACE_KEY';

  const pageHeaders = buildPageHeaders({
    space: pageSpace,
    parent: yearBaseName,
    title: pageTitle,
    pageId: '',
  });

  const baseVars = computeTemplateVars(talkRow, options, coreConfig);
  const pageVars = {
    ...baseVars,
    TalkNumber: trimCell(talkRow['Talk #']) || '',
    TalkDate: talkDate,
    Focus: trimCell(talkRow['Focus']) || 'TBD',
    Duration: normalizeDurationForDisplay(talkRow['Duration']) || 'TBD',
    Summary: trimCell(talkRow['Summary']) || 'Sin summary cargado.',
    Video: trimCell(talkRow['Video']) || 'Sin video cargado.',
    Attendees: trimCell(talkRow['Attendees']) || 'TBD',
    Confluence: trimCell(talkRow['Confluence']) || '',
    Links: normalizeLinksForPage(talkRow['Links'], talkRow['Video']),
    Notes: trimCell(talkRow['Notes']) || '',
    talk: {
      ...(baseVars.talk || {}),
      ...buildTalkTemplateContext(talkRow, talkDate),
      date: talkDate,
      talk_date: talkDate,
      talkDate,
    },
  };

  const pageTemplatePath = resolvePageTemplatePath(rootDir);
  const pageContent = pageTemplatePath && fs.existsSync(pageTemplatePath)
    ? renderTemplate(fs.readFileSync(pageTemplatePath, 'utf8'), pageVars)
    : buildGenericPageBody(talkRow, talkDate);

  const body = `${pageTitle}\n${'='.repeat(pageTitle.length)}\n\n${pageContent}`;

  fs.writeFileSync(outputPath, pageHeaders + body, 'utf8');
  const rel = path.relative(process.cwd(), outputPath) || outputPath;
  console.log(`✓ upserted ${rel}`);
}

async function videoCommand(options) {
  const { configPath, config: coreConfig } = loadCoreConfig({ startDir: process.cwd(), required: false });
  const rootDir = getWorkspaceRootDir(configPath);
  const schedulePath = resolveSchedulePath(options.schedulePath, rootDir, options);
  if (!fs.existsSync(schedulePath)) {
    throw new Error(`Schedule file not found: ${schedulePath}`);
  }

  const scheduleData = readScheduleWithComments(schedulePath);
  if (scheduleData.rows.length === 0) {
    throw new Error('Schedule CSV is empty or invalid');
  }

  const rows = scheduleData.rows;
  const headers = ensureColumns(rows, scheduleData.headers, ['Video', 'Duration']);
  const talkRow = findTalkRow(rows, options);
  if (!talkRow) {
    throw new Error('No talk row found with provided selector (--talk/--date)');
  }

  const talkRef = trimCell(talkRow['Talk #']) || '?';
  const talkTitle = trimCell(talkRow['Title']) || 'Untitled';
  console.log(`! processing talk ${talkRef}: ${talkTitle}`);
  const sharePointArchiveConfig = getSharePointVideoArchiveConfig(coreConfig || {});
  const hasSharePointArchiveUrl = isConfiguredValue(sharePointArchiveConfig?.url);
  let sharePointReady = isSharePointVideoConfigured(coreConfig || {});

  if (!sharePointReady && hasSharePointArchiveUrl && configPath) {
    try {
      const ids = await resolveSharePointArchiveFromUrl(sharePointArchiveConfig.url, coreConfig || {});
      const talk = ensureObject(coreConfig, 'talk');
      const videoArchive = ensureObject(talk, 'video_archive');

      talk.video_archive_url = sharePointArchiveConfig.url;
      videoArchive.site_id = ids.siteId;
      videoArchive.drive_id = ids.driveId;
      videoArchive.folder_id = ids.archiveParentId;
      applySharePointArchiveDefaults(videoArchive);
      delete videoArchive.url;
      delete videoArchive.share_url;
      delete videoArchive.archive_parent_id;

      writeYamlFile(configPath, coreConfig);
      appendInlineTokenPlaceholders(configPath, coreConfig);
      sharePointReady = true;
      console.log('✓ resolved SharePoint archive IDs from saved folder URL');
    } catch (error) {
      console.log(`! could not resolve SharePoint archive IDs from saved URL: ${error.message}`);
    }
  }

  const current = trimCell(talkRow['Video']);
  let videoUrl = current;
  if (!videoUrl) {
    const prompt = (sharePointReady || hasSharePointArchiveUrl)
      ? 'Video share URL: '
      : 'Video URL: ';
    const answer = await askInteractive(prompt);
    videoUrl = answer || current;
  }

  if (!videoUrl) {
    throw new Error('Missing video url. Enter a value at the prompt or fill the Video column in schedule.csv.');
  }

  let finalVideoUrl = videoUrl;
  let finalDuration = trimCell(options.duration || talkRow['Duration']);
  let finalAttendees = trimCell(options.attendees || talkRow['Attendees']);
  if (sharePointReady) {
    const archived = await archiveVideoToSharePoint({
      shareUrl: videoUrl,
      talkRow,
      coreConfig: coreConfig || {},
    });
    finalVideoUrl = archived.previewUrl;
    finalDuration = archived.duration || finalDuration;
    console.log(`✓ archived video to SharePoint ${archived.year}/${archived.finalName}`);
    if (archived.metadataWarning) {
      console.log(`! ${archived.metadataWarning}`);
    }
    if (archived.duration) {
      console.log(`! captured video duration: ${archived.duration}`);
    }
  } else if (hasSharePointArchiveUrl) {
    console.log('! SharePoint archive is not ready yet; saving the provided video URL without archive processing');
  }

  if (!trimCell(finalDuration) && !options.noPrompt) {
    const answer = await askInteractive('Video duration (HH:MM:SS) (optional, enter to skip): ');
    if (answer) {
      finalDuration = trimCell(answer);
    }
  }

  if (!trimCell(finalAttendees) && !options.noPrompt) {
    const answer = await askInteractive('Attendees count (optional, enter to skip): ');
    if (answer) {
      finalAttendees = trimCell(answer);
    }
  }

  const prevVideo = trimCell(talkRow['Video']);
  const prevDuration = trimCell(talkRow['Duration']);
  const prevAttendees = trimCell(talkRow['Attendees']);
  const nextDuration = trimCell(finalDuration);
  const nextAttendees = trimCell(finalAttendees);
  const videoChanged = prevVideo !== finalVideoUrl;
  const durationChanged = nextDuration && nextDuration !== prevDuration;
  const attendeesChanged = nextAttendees !== prevAttendees;

  if (!videoChanged && !durationChanged && !attendeesChanged) {
    console.log(`✓ up-to-date talk ${talkRef} (video unchanged)`);
    return;
  }

  talkRow['Video'] = finalVideoUrl;
  if (nextDuration) {
    talkRow['Duration'] = nextDuration;
  }
  talkRow['Attendees'] = nextAttendees;
  writeScheduleWithComments(schedulePath, scheduleData.comments, rows, headers);

  const relSchedule = path.relative(process.cwd(), schedulePath) || schedulePath;
  if (!videoChanged && durationChanged) {
    console.log(`✓ updated ${relSchedule} (talk ${talkRef} duration backfilled)`);
  } else {
    console.log(`✓ updated ${relSchedule} (talk ${talkRef} video)`);
  }
}

async function publishCommand(options) {
  console.log('talk publish is deprecated; use: padd talk page');
  await createCommand(options);
}

export async function run(args) {
  const { command, options } = parseArgs(args);

  if (options.help || !command) {
    showHelp();
    process.exit(0);
  }

  if (command === 'init') {
    await initCommand(options);
    process.exit(0);
  }

  if (command === 'msg') {
    await announcementsCommand(options);
    process.exit(0);
  }

  if (command === 'page') {
    await createCommand(options);
    process.exit(0);
  }

  if (command === 'create' || command === 'create-talk') {
    console.log('talk create is deprecated; use: padd talk page');
    await createCommand(options);
    process.exit(0);
  }

  if (command === 'video') {
    await videoCommand(options);
    process.exit(0);
  }

  if (command === 'archive-video') {
    console.log('talk archive-video is deprecated; use: padd talk video');
    await videoCommand(options);
    process.exit(0);
  }

  if (command === 'publish') {
    await publishCommand(options);
    process.exit(0);
  }

  console.error(`\n❌ Unknown talk command: ${command}`);
  console.error('   Run: padd talk --help\n');
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2)).catch((err) => {
    console.error(`\n❌ Error: ${err.message}\n`);
    process.exit(1);
  });
}
