/**
 * padd - Main Entry Point
 * 
 * Barrel export for convenient imports.
 * 
 * @example
 * // Import everything from the main module
 * import { ConfluenceClient, SharePointClient, loadAuth } from 'padd';
 * 
 * // Or import specific modules (still works)
 * import { ConfluenceClient } from 'padd/lib/confluence-client.js';
 */

// API Clients
export { ConfluenceClient } from './lib/confluence-client.js';
export { SharePointClient } from './lib/sharepoint-client.js';

// Auth Management
export {
  findAuthPath,
  loadAuthFile,
  saveAuthFile,
  checkFilePermissions,
  loadAuth,
  saveAuth,
  getProvider,
  updateProvider,
  removeProvider,
  listProviders,
  getProviderCredentials
} from './lib/auth-storage.js';

export {
  refreshProvider,
  refreshMsGraphToken,
  refreshConfluenceToken,
  refreshInteractive
} from './lib/auth-refresh.js';

// Config Management
export {
  findConfigPath,
  loadConfigFile,
  mergeConfigs,
  validateConfig,
  loadConfig,
  getConfigValue,
  debugConfig
} from './lib/config-loader.js';

// CSV Utilities
export {
  arrayToCsv,
  csvToArray,
  csvToObjects,
  objectsToCsv
} from './lib/csv-utils.js';

// Config Discovery
export {
  findDomainConfig,
  findTalkConfig,
  getRepoRoot
} from './lib/config-discovery.js';
