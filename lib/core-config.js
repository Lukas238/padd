/**
 * core-config.js
 *
 * YAML-based multicore config discovery for padd.
 * Designed for shared config files containing sections per core:
 *
 * sharepoint:
 *   access_token: "..."
 *   excel:
 *     schedule:
 *       sharing_url: "https://..."
 *       sheets:
 *         Schedule: schedule.csv
 *         Topics: topics_backlog.csv
 *
 * confluence:
 *   server: "https://..."
 *   token: "..."
 */

import fs from 'fs';
import path from 'path';
import YAML from 'yaml';

export const DEFAULT_CORE_CONFIG_FILENAMES = [
  '.padd.yaml',
  '.padd.yml',
  'padd.yaml',
  'padd.yml',
];

export function findCoreConfigPath(options = {}) {
  const {
    startDir = process.cwd(),
    configFilenames = DEFAULT_CORE_CONFIG_FILENAMES,
  } = options;

  let currentDir = path.resolve(startDir);
  const fsRoot = path.parse(currentDir).root;

  while (true) {
    for (const filename of configFilenames) {
      const candidate = path.join(currentDir, filename);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    if (currentDir === fsRoot) {
      break;
    }

    currentDir = path.dirname(currentDir);
  }

  return null;
}

export function loadCoreConfigFile(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Core config file not found: ${configPath}`);
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = YAML.parse(raw);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid YAML structure in ${configPath}`);
  }

  return parsed;
}

export function loadCoreConfig(options = {}) {
  const {
    startDir = process.cwd(),
    configPath = null,
    required = false,
  } = options;

  const resolvedPath = configPath || findCoreConfigPath({ startDir });

  if (!resolvedPath) {
    if (required) {
      throw new Error(
        `No padd core config file found.\n` +
          `Searched from: ${startDir}\n` +
          `Expected one of: ${DEFAULT_CORE_CONFIG_FILENAMES.join(', ')}`
      );
    }
    return { configPath: null, config: null };
  }

  const config = loadCoreConfigFile(resolvedPath);
  return { configPath: resolvedPath, config };
}

export function getCoreSection(config, coreName, { required = false, configPath = 'config' } = {}) {
  const section = config?.[coreName];

  if (required && (!section || typeof section !== 'object')) {
    throw new Error(`Missing '${coreName}' section in ${configPath}`);
  }

  return section || null;
}

export function getSharePointAccessToken(config, { required = false, configPath = 'config' } = {}) {
  const sharepoint = getCoreSection(config, 'sharepoint', { required, configPath });
  const token = sharepoint?.access_token || sharepoint?.accessToken;

  if (required && !token) {
    throw new Error(`Missing sharepoint.access_token in ${configPath}`);
  }

  return token || null;
}
