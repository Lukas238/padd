#!/usr/bin/env node

/**
 * padd - Auth Storage
 *
 * Manages reading/writing encrypted credential files (auth.enc.json).
 * Designed to be portable and work as standalone npm package.
 *
 * Features:
 * - Auto-discovery via upward directory walk
 * - Support for legacy and new credential formats
 * - Secure file permissions checking
 * - Atomic writes with backup
 * - Zero external dependencies
 *
 * @module lib/auth-storage
 * @version 1.0.0
 * @license MIT
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ============================================================================
// Auth File Discovery
// ============================================================================

/**
 * Find auth.enc.json by walking UP from startDir
 *
 * @param {Object} options - Search options
 * @param {string} options.startDir - Directory to start search from (default: process.cwd())
 * @param {string} options.filename - Auth filename to search for (default: 'auth.enc.json')
 * @param {string} options.stopAtDir - Directory to stop search at (optional)
 * @param {number} options.maxLevels - Maximum levels to search up (default: 10)
 * @returns {string|null} - Path to auth file or null if not found
 *
 * @example
 * const authPath = findAuthPath({ startDir: process.cwd() });
 */
export function findAuthPath(options = {}) {
  const {
    startDir = process.cwd(),
    filename = 'auth.enc.json',
    stopAtDir = null,
    maxLevels = 10,
  } = options;

  let currentDir = path.resolve(startDir);
  let levelsSearched = 0;

  while (levelsSearched < maxLevels) {
    const authPath = path.join(currentDir, filename);

    if (fs.existsSync(authPath)) {
      return authPath;
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
// Auth File I/O
// ============================================================================

/**
 * Check file permissions and warn if insecure
 *
 * @param {string} filePath - Path to auth file
 * @returns {Object} - { secure: boolean, warnings: string[] }
 */
export function checkFilePermissions(filePath) {
  const warnings = [];

  try {
    const stats = fs.statSync(filePath);
    const mode = stats.mode & 0o777;

    // Check if world-readable (last 3 bits)
    if (mode & 0o004) {
      warnings.push('File is world-readable (chmod 600 recommended)');
    }

    // Check if group-readable (middle 3 bits)
    if (mode & 0o040) {
      warnings.push('File is group-readable (chmod 600 recommended)');
    }

    return {
      secure: warnings.length === 0,
      warnings,
      mode: mode.toString(8),
    };
  } catch (error) {
    return {
      secure: false,
      warnings: [`Cannot check permissions: ${error.message}`],
    };
  }
}

/**
 * Load and parse auth.enc.json file
 *
 * Supports both legacy and new formats:
 * - Legacy: { microsoft_graph: {...}, confluence: {...} }
 * - New: { providers: { ms-graph: {...}, confluence: {...} } }
 *
 * @param {string} filePath - Path to auth file
 * @param {Object} options - Loading options
 * @param {boolean} options.checkPermissions - Check file permissions (default: true)
 * @param {boolean} options.silent - Don't log warnings (default: false)
 * @returns {Object} - Parsed auth object
 * @throws {Error} - If file not found or invalid JSON
 *
 * @example
 * const auth = loadAuthFile('./auth.enc.json');
 */
export function loadAuthFile(filePath, options = {}) {
  const {
    checkPermissions: shouldCheckPermissions = true,
    silent = false,
  } = options;

  if (!fs.existsSync(filePath)) {
    throw new Error(`Auth file not found: ${filePath}`);
  }

  // Check file permissions
  if (shouldCheckPermissions && !silent) {
    const permCheck = checkFilePermissions(filePath);
    if (!permCheck.secure && !silent) {
      console.warn(`\n⚠️  Auth file permissions warning:`);
      permCheck.warnings.forEach(w => console.warn(`   ${w}`));
      console.warn(`   Current mode: ${permCheck.mode}`);
      console.warn(`   Run: chmod 600 ${filePath}\n`);
    }
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    // Remove BOM if present
    const cleanContent = content.charCodeAt(0) === 0xFEFF ? content.substring(1) : content;
    const auth = JSON.parse(cleanContent);

    // Normalize to new format if legacy
    return normalizeAuthFormat(auth);
  } catch (error) {
    throw new Error(`Invalid JSON in auth file ${filePath}: ${error.message}`);
  }
}

/**
 * Normalize legacy auth format to new format
 *
 * Handles three formats:
 * 1. New: { providers: { ms-graph: {...}, confluence: {...} } }
 * 2. Legacy named: { microsoft_graph: {...}, confluence: {...} }
 * 3. Legacy flat: { username, access_token, ... } (single provider)
 *
 * @param {Object} auth - Raw auth object
 * @returns {Object} - Normalized auth object
 */
function normalizeAuthFormat(auth) {
  // Already new format
  if (auth.providers) {
    return auth;
  }

  const providers = {};

  // Check for legacy named providers format
  const namedProviders = {
    'microsoft_graph': 'ms-graph',
    'confluence': 'confluence',
    'aws': 'aws',
  };

  let foundNamedProvider = false;
  for (const [legacyName, newName] of Object.entries(namedProviders)) {
    if (auth[legacyName]) {
      providers[newName] = auth[legacyName];
      foundNamedProvider = true;
    }
  }

  // If we found named providers, use those
  if (foundNamedProvider) {
    return {
      providers,
      _meta: {
        version: '1.0',
        migrated_from: 'legacy_named',
        migrated_at: new Date().toISOString(),
      },
    };
  }

  // Check for legacy flat format (single provider)
  // This has access_token, username, etc. at root level
  if (auth.access_token || auth.username) {
    // Assume this is Microsoft Graph (legacy default)
    providers['ms-graph'] = {
      ...auth,
    };

    return {
      providers,
      _meta: {
        version: '1.0',
        migrated_from: 'legacy_flat',
        migrated_at: new Date().toISOString(),
      },
    };
  }

  // Unknown format - return as-is with warning
  return {
    providers: {},
    _meta: {
      version: '1.0',
      warning: 'Unknown auth format - no providers detected',
    },
  };
}

/**
 * Save auth data to file
 *
 * Creates backup before writing. Uses atomic write (write to temp + rename).
 *
 * @param {string} filePath - Path to auth file
 * @param {Object} auth - Auth data to save
 * @param {Object} options - Save options
 * @param {boolean} options.backup - Create backup before writing (default: true)
 * @param {boolean} options.atomic - Use atomic write (default: true)
 * @param {boolean} options.updateMeta - Update _meta timestamp (default: true)
 * @throws {Error} - If write fails
 *
 * @example
 * saveAuthFile('./auth.enc.json', { providers: { ... } });
 */
export function saveAuthFile(filePath, auth, options = {}) {
  const {
    backup = true,
    atomic = true,
    updateMeta = true,
  } = options;

  // Update metadata
  if (updateMeta) {
    if (!auth._meta) {
      auth._meta = { version: '1.0' };
    }
    auth._meta.last_updated = new Date().toISOString();
  }

  const content = JSON.stringify(auth, null, 2) + '\n';

  // Create backup
  if (backup && fs.existsSync(filePath)) {
    const backupPath = `${filePath}.backup`;
    fs.copyFileSync(filePath, backupPath);
  }

  if (atomic) {
    // Atomic write: write to temp file, then rename
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, content, { mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } else {
    // Direct write
    fs.writeFileSync(filePath, content, { mode: 0o600 });
  }
}

// ============================================================================
// Provider CRUD Operations
// ============================================================================

/**
 * Get credentials for a specific provider
 *
 * @param {Object} auth - Auth object
 * @param {string} providerName - Provider name (e.g., 'ms-graph')
 * @returns {Object|null} - Provider credentials or null if not found
 *
 * @example
 * const graphCreds = getProvider(auth, 'ms-graph');
 */
export function getProvider(auth, providerName) {
  if (!auth.providers || !auth.providers[providerName]) {
    return null;
  }

  return auth.providers[providerName];
}

/**
 * Update credentials for a specific provider
 *
 * @param {Object} auth - Auth object
 * @param {string} providerName - Provider name
 * @param {Object} credentials - New credentials
 * @returns {Object} - Updated auth object
 *
 * @example
 * const updated = updateProvider(auth, 'ms-graph', { access_token: '...' });
 */
export function updateProvider(auth, providerName, credentials) {
  if (!auth.providers) {
    auth.providers = {};
  }

  auth.providers[providerName] = {
    ...auth.providers[providerName],
    ...credentials,
    _updated_at: new Date().toISOString(),
  };

  return auth;
}

/**
 * Remove a provider from auth
 *
 * @param {Object} auth - Auth object
 * @param {string} providerName - Provider name
 * @returns {Object} - Updated auth object
 */
export function removeProvider(auth, providerName) {
  if (auth.providers && auth.providers[providerName]) {
    delete auth.providers[providerName];
  }

  return auth;
}

/**
 * List all providers in auth
 *
 * @param {Object} auth - Auth object
 * @returns {string[]} - Array of provider names
 */
export function listProviders(auth) {
  if (!auth.providers) {
    return [];
  }

  return Object.keys(auth.providers);
}

// ============================================================================
// High-Level API
// ============================================================================

/**
 * Load auth file with auto-discovery
 *
 * @param {Object} options - Loading options
 * @param {string} options.authPath - Explicit auth file path (overrides discovery)
 * @param {string} options.startDir - Directory to start search (default: cwd)
 * @param {string} options.filename - Auth filename (default: 'auth.enc.json')
 * @param {boolean} options.required - Throw error if not found (default: true)
 * @param {boolean} options.silent - Don't log warnings (default: false)
 * @returns {Object} - { auth, authPath }
 * @throws {Error} - If auth file not found and required=true
 *
 * @example
 * const { auth, authPath } = loadAuth();
 * const { auth } = loadAuth({ authPath: './custom-auth.enc.json' });
 */
export function loadAuth(options = {}) {
  const {
    authPath: explicitAuthPath = null,
    startDir = process.cwd(),
    filename = 'auth.enc.json',
    required = true,
    silent = false,
  } = options;

  // Use explicit path or discover
  let authPath = explicitAuthPath;

  if (!authPath) {
    authPath = findAuthPath({ startDir, filename });

    if (!authPath) {
      if (required) {
        throw new Error(
          `No auth file found.\n\n` +
          `Searched for: ${filename}\n` +
          `Starting from: ${startDir}\n\n` +
          `Please create an auth file or use --auth to specify path.\n` +
          `Run: padd auth init`
        );
      } else {
        return { auth: null, authPath: null };
      }
    }
  }

  const auth = loadAuthFile(authPath, { silent });

  return { auth, authPath };
}

/**
 * Save auth with atomic write and backup
 *
 * @param {string} authPath - Path to auth file
 * @param {Object} auth - Auth data
 * @param {Object} options - Save options
 */
export function saveAuth(authPath, auth, options = {}) {
  saveAuthFile(authPath, auth, options);
}

/**
 * Get provider credentials with auto-load
 *
 * @param {string} providerName - Provider name
 * @param {Object} options - Loading options
 * @returns {Object|null} - Provider credentials
 *
 * @example
 * const graphCreds = getProviderCredentials('ms-graph');
 */
export function getProviderCredentials(providerName, options = {}) {
  const { auth } = loadAuth(options);
  return getProvider(auth, providerName);
}

// ============================================================================
// CLI Test Mode
// ============================================================================

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('\n🔐 Auth Storage - Test Mode\n');

  const args = process.argv.slice(2);
  const command = args[0] || 'info';
  const authPath = args.find(arg => arg.startsWith('--auth='))?.split('=')[1] ||
                   (args.indexOf('--auth') >= 0 ? args[args.indexOf('--auth') + 1] : null);

  try {
    if (command === 'info') {
      const { auth, authPath: discoveredPath } = loadAuth({ authPath, required: false });

      if (!auth) {
        console.log('❌ No auth file found\n');
        process.exit(1);
      }

      console.log('📁 Auth File Info');
      console.log('─'.repeat(60));
      console.log(`Path: ${discoveredPath}`);
      console.log(`Version: ${auth._meta?.version || 'legacy'}`);

      if (auth._meta?.migrated_from) {
        console.log(`Migrated From: ${auth._meta.migrated_from}`);
      }

      console.log(`Providers: ${listProviders(auth).length}`);

      const permCheck = checkFilePermissions(discoveredPath);
      console.log(`Secure: ${permCheck.secure ? '✅' : '⚠️'} (mode: ${permCheck.mode})`);

      console.log('\n🔑 Providers');
      console.log('─'.repeat(60));

      for (const name of listProviders(auth)) {
        const provider = getProvider(auth, name);
        console.log(`\n${name}:`);

        if (provider.access_token) {
          console.log(`  Access Token: ${provider.access_token.substring(0, 20)}...`);
        }

        if (provider.expires_at) {
          const expiresAt = new Date(provider.expires_at);
          const now = new Date();
          const diffMs = expiresAt - now;
          const diffMin = Math.floor(diffMs / 60000);

          if (diffMin > 0) {
            console.log(`  Expires: in ${diffMin} minutes`);
          } else {
            console.log(`  Expires: ${Math.abs(diffMin)} minutes ago ⚠️`);
          }
        }

        if (provider._updated_at) {
          console.log(`  Updated: ${provider._updated_at}`);
        }
      }

      console.log('');
    } else if (command === 'list') {
      const { auth } = loadAuth({ authPath });
      console.log('Providers:', listProviders(auth).join(', '));
    } else if (command === 'migrate') {
      console.log('🔄 Migrating auth file to new format...\n');

      const { auth, authPath: discoveredPath } = loadAuth({ authPath, silent: true });

      // Check if already migrated
      if (auth.providers && !auth._meta?.migrated_from) {
        console.log('✅ Auth file is already in new format\n');
        process.exit(0);
      }

      console.log('📁 Source File');
      console.log('─'.repeat(60));
      console.log(`Path: ${discoveredPath}`);

      if (auth._meta?.migrated_from) {
        console.log(`Format: ${auth._meta.migrated_from} (auto-converted on load)`);
      } else {
        console.log(`Format: Unknown legacy format`);
      }

      console.log(`\n📦 Detected Providers: ${listProviders(auth).length}`);
      for (const name of listProviders(auth)) {
        console.log(`  - ${name}`);
      }

      // Save in new format
      console.log('\n💾 Saving to new format...');
      saveAuth(discoveredPath, auth, { backup: true });

      console.log('✅ Migration complete!\n');
      console.log(`Backup saved as: ${discoveredPath}.backup`);
      console.log(`\n💡 Tip: Run 'node auth-storage.js info' to verify\n`);

    } else {
      console.log('Usage:');
      console.log('  node auth-storage.js info [--auth path]    # Show auth file info');
      console.log('  node auth-storage.js list [--auth path]    # List providers');
      console.log('  node auth-storage.js migrate [--auth path] # Migrate to new format');
    }
  } catch (error) {
    console.error(`
❌ Error: ${error.message}
`);
    process.exit(1);
  }
}
