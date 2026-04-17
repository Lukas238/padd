#!/usr/bin/env node

/**
 * padd - Config Loader
 *
 * Generic cascading configuration system for operational scripts.
 * Designed to work as standalone npm package or in-repo utility.
 *
 * Features:
 * - Auto-discovery via upward directory walk
 * - Cascading config merge (defaults → workspace → CLI)
 * - Pluggable validation
 * - Zero external dependencies
 * - Works with any config filename pattern
 *
 * @module lib/config-loader
 * @version 1.0.0
 * @license MIT
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ============================================================================
// Config Discovery
// ============================================================================

/**
 * Find config file by walking UP from startDir
 *
 * Stops when:
 * - Config file found
 * - Reaches stopAtDir (if provided)
 * - Reaches filesystem root
 *
 * @param {Object} options - Search options
 * @param {string} options.startDir - Directory to start search from (default: process.cwd())
 * @param {string} options.configFilename - Config filename to search for (default: 'config.json')
 * @param {string[]} options.configFilenames - Alternative: array of filenames to try
 * @param {string} options.stopAtDir - Directory to stop search at (optional)
 * @param {number} options.maxLevels - Maximum levels to search up (default: 10)
 * @returns {string|null} - Path to config file or null if not found
 *
 * @example
 * // Search for config.json
 * const path = findConfigPath({ startDir: process.cwd() });
 *
 * @example
 * // Search for multiple possible config files
 * const path = findConfigPath({
 *   configFilenames: ['talks.config.json', 'config.json']
 * });
 */
export function findConfigPath(options = {}) {
  const {
    startDir = process.cwd(),
    configFilename = 'config.json',
    configFilenames = null,
    stopAtDir = null,
    maxLevels = 10,
  } = options;

  // Determine which filenames to search for
  const filenames = configFilenames || [configFilename];

  let currentDir = path.resolve(startDir);
  let levelsSearched = 0;

  while (levelsSearched < maxLevels) {
    // Try each filename in order
    for (const filename of filenames) {
      const configPath = path.join(currentDir, filename);

      if (fs.existsSync(configPath)) {
        return configPath;
      }
    }

    // Stop if we reached the specified stop directory
    if (stopAtDir && currentDir === path.resolve(stopAtDir)) {
      return null;
    }

    // Stop at filesystem root
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
    levelsSearched++;
  }

  return null;
}

// ============================================================================
// Config File I/O
// ============================================================================

/**
 * Load and parse JSON config file
 *
 * @param {string} filePath - Path to config file
 * @returns {Object} - Parsed config object
 * @throws {Error} - If file not found or invalid JSON
 */
export function loadConfigFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Config file not found: ${filePath}`);
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    // Remove BOM if present
    const cleanContent = content.charCodeAt(0) === 0xFEFF ? content.substring(1) : content;
    return JSON.parse(cleanContent);
  } catch (error) {
    throw new Error(`Invalid JSON in config file ${filePath}: ${error.message}`);
  }
}

/**
 * Deep merge two config objects
 *
 * Later config overrides earlier config.
 * - Primitives and arrays: direct override
 * - Objects: recursive merge
 *
 * @param {Object} base - Base config object
 * @param {Object} override - Override config object
 * @returns {Object} - Merged config
 *
 * @example
 * mergeConfigs(
 *   { a: 1, b: { c: 2 } },
 *   { b: { d: 3 } }
 * )
 * // => { a: 1, b: { c: 2, d: 3 } }
 */
export function mergeConfigs(base, override) {
  const result = { ...base };

  for (const key in override) {
    if (override[key] === null || override[key] === undefined) {
      continue;
    }

    if (
      typeof override[key] === 'object' &&
      !Array.isArray(override[key]) &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      // Recursive merge for nested objects
      result[key] = mergeConfigs(result[key] || {}, override[key]);
    } else {
      // Direct override for primitives and arrays
      result[key] = override[key];
    }
  }

  return result;
}

// ============================================================================
// Config Validation
// ============================================================================

/**
 * Default validator: checks for required fields using dot notation
 *
 * @param {Object} config - Config to validate
 * @param {string[]} requiredFields - Array of required field paths (e.g., 'server.port')
 * @throws {Error} - If required fields are missing
 *
 * @example
 * validateConfig(config, ['server.port', 'database.host']);
 */
export function validateConfig(config, requiredFields = []) {
  const missing = [];

  for (const fieldPath of requiredFields) {
    const parts = fieldPath.split('.');
    let current = config;

    for (const part of parts) {
      if (!current || current[part] === undefined) {
        missing.push(fieldPath);
        break;
      }
      current = current[part];
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Config validation failed. Missing required fields:\n` +
      `  - ${missing.join('\n  - ')}\n\n` +
      `Please check your configuration file.`
    );
  }
}

// ============================================================================
// Main Config Loader
// ============================================================================

/**
 * Load complete config with cascading overrides
 *
 * Precedence (highest to lowest):
 * 1. CLI config (cliConfigPath)
 * 2. Workspace config (auto-discovered)
 * 3. Default config (defaultConfigPath)
 *
 * @param {Object} options - Loading options
 * @param {string} options.defaultConfigPath - Path to default config file (optional)
 * @param {Object} options.defaultConfig - Default config object (alternative to path)
 * @param {string} options.cliConfigPath - Explicit config path from CLI (optional)
 * @param {string} options.startDir - Directory to start config search (default: cwd)
 * @param {string} options.configFilename - Config filename to search for
 * @param {string[]} options.configFilenames - Alternative: array of filenames to try
 * @param {string} options.stopAtDir - Directory to stop search at
 * @param {Function} options.validator - Custom validator function(config)
 * @param {string[]} options.requiredFields - Required fields for default validator
 * @param {boolean} options.skipValidation - Skip validation (for testing)
 * @param {boolean} options.requireWorkspaceConfig - Throw error if no workspace config found
 * @returns {Object} - Complete merged config with _meta property
 *
 * @example
 * // Basic usage with default config
 * const config = loadConfig({
 *   defaultConfigPath: './default-config.json',
 *   requiredFields: ['server.port', 'database.host']
 * });
 *
 * @example
 * // With custom validator
 * const config = loadConfig({
 *   defaultConfig: { timeout: 30 },
 *   validator: (cfg) => {
 *     if (cfg.timeout < 10) throw new Error('Timeout too low');
 *   }
 * });
 *
 * @example
 * // Search for domain-specific config
 * const config = loadConfig({
 *   configFilenames: ['talks.config.json', 'config.json'],
 *   defaultConfigPath: './talks/default-config.json'
 * });
 */
export function loadConfig(options = {}) {
  const {
    defaultConfigPath = null,
    defaultConfig = null,
    cliConfigPath = null,
    startDir = process.cwd(),
    configFilename = 'config.json',
    configFilenames = null,
    stopAtDir = null,
    validator = null,
    requiredFields = [],
    skipValidation = false,
    requireWorkspaceConfig = true,
  } = options;

  let config = {};
  const metadata = {
    defaultConfigPath: null,
    workspaceConfigPath: null,
    cliConfigPath: null,
    loadedFrom: startDir,
    configFilename: configFilename,
  };

  // Step 1: Load default config (lowest priority)
  if (defaultConfig) {
    config = mergeConfigs(config, defaultConfig);
  } else if (defaultConfigPath && fs.existsSync(defaultConfigPath)) {
    const defaultCfg = loadConfigFile(defaultConfigPath);
    config = mergeConfigs(config, defaultCfg);
    metadata.defaultConfigPath = defaultConfigPath;
  }

  // Step 2: Auto-discover and load workspace config
  if (!cliConfigPath) {
    const workspaceConfigPath = findConfigPath({
      startDir,
      configFilename,
      configFilenames,
      stopAtDir,
    });

    if (workspaceConfigPath) {
      const workspaceCfg = loadConfigFile(workspaceConfigPath);
      config = mergeConfigs(config, workspaceCfg);
      metadata.workspaceConfigPath = workspaceConfigPath;
    } else if (requireWorkspaceConfig) {
      const searchNames = configFilenames || [configFilename];
      throw new Error(
        `No config file found.\n\n` +
        `Searched for: ${searchNames.join(', ')}\n` +
        `Starting from: ${startDir}\n` +
        `Stop directory: ${stopAtDir || 'filesystem root'}\n\n` +
        `Please run this script from a workspace directory with a config file,\n` +
        `or use --config to specify a config file explicitly.`
      );
    }
  }

  // Step 3: Load CLI-specified config (highest priority)
  if (cliConfigPath) {
    const cliCfg = loadConfigFile(cliConfigPath);
    config = mergeConfigs(config, cliCfg);
    metadata.cliConfigPath = cliConfigPath;
  }

  // Step 4: Validate merged config
  if (!skipValidation) {
    if (validator) {
      // Custom validator
      validator(config);
    } else if (requiredFields.length > 0) {
      // Default validator
      validateConfig(config, requiredFields);
    }
  }

  // Add metadata
  config._meta = metadata;

  return config;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get config value by dot-notation path
 *
 * @param {Object} config - Config object
 * @param {string} path - Dot-notation path (e.g., 'server.port')
 * @param {*} defaultValue - Default value if path not found
 * @returns {*} - Config value or default
 *
 * @example
 * getConfigValue(config, 'server.port', 3000);
 */
export function getConfigValue(config, path, defaultValue = null) {
  const parts = path.split('.');
  let current = config;

  for (const part of parts) {
    if (!current || current[part] === undefined) {
      return defaultValue;
    }
    current = current[part];
  }

  return current;
}

/**
 * Debug: Print config loading info
 *
 * @param {Object} config - Loaded config with _meta
 * @param {Object} options - Display options
 * @param {boolean} options.showFull - Show full config object (default: false)
 * @param {string[]} options.highlightFields - Fields to highlight in output
 */
export function debugConfig(config, options = {}) {
  const { showFull = false, highlightFields = [] } = options;

  console.log('\n📋 Config Loading Info');
  console.log('─'.repeat(60));

  if (config._meta) {
    console.log(`Loaded From:      ${config._meta.loadedFrom}`);

    if (config._meta.defaultConfigPath) {
      console.log(`Default Config:   ${config._meta.defaultConfigPath}`);
    }

    if (config._meta.workspaceConfigPath) {
      console.log(`Workspace Config: ${config._meta.workspaceConfigPath}`);
    }

    if (config._meta.cliConfigPath) {
      console.log(`CLI Config:       ${config._meta.cliConfigPath}`);
    }
  }

  if (highlightFields.length > 0) {
    console.log('\n📦 Key Configuration');
    console.log('─'.repeat(60));
    for (const field of highlightFields) {
      const value = getConfigValue(config, field);
      console.log(`${field}: ${JSON.stringify(value)}`);
    }
  }

  if (showFull) {
    console.log('\n🔍 Full Config Object');
    console.log('─'.repeat(60));
    const { _meta, ...configWithoutMeta } = config;
    console.log(JSON.stringify(configWithoutMeta, null, 2));
  }

  console.log('');
}

// ============================================================================
// CLI Test Mode
// ============================================================================

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('\n🔧 Config Loader - Standalone Test Mode\n');

  const args = process.argv.slice(2);
  const cliConfigPath = args.find(arg => arg.startsWith('--config='))?.split('=')[1] ||
                        (args.indexOf('--config') >= 0 ? args[args.indexOf('--config') + 1] : null);

  try {
    const config = loadConfig({
      cliConfigPath,
      requireWorkspaceConfig: false,
      skipValidation: true,
    });

    debugConfig(config, { showFull: true });
    console.log('✅ Config loader working correctly!\n');
  } catch (error) {
    console.error(`\n❌ Error: ${error.message}\n`);
    process.exit(1);
  }
}
