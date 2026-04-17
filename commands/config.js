#!/usr/bin/env node

/**
 * padd config - Configuration Management
 *
 * Commands:
 *   padd config init [domain]    Initialize config file
 *   padd config validate         Validate current config
 *   padd config show             Show current config
 *
 * @module commands/config
 */

import fs from 'fs';
import path from 'path';
import { loadConfig, debugConfig, findConfigPath } from '../lib/config-loader.js';

// ============================================================================
// Command Handlers
// ============================================================================

/**
 * Initialize config file
 */
async function configInit(domain, options = {}) {
  const { force = false } = options;
  const filename = domain ? `config.${domain}.json` : 'config.json';
  const targetPath = path.join(process.cwd(), filename);

  // Check if already exists
  if (fs.existsSync(targetPath) && !force) {
    console.error(`\n❌ ${filename} already exists at: ${targetPath}`);
    console.error(`   Use --force to overwrite\n`);
    process.exit(1);
  }

  // Create template config
  const templateConfig = {
    version: '1.0',
    created_at: new Date().toISOString(),
    
    // Example structure (users should customize)
    settings: {
      // Add your configuration here
    },

    _meta: {
      description: domain 
        ? `Configuration file for ${domain} domain`
        : 'General configuration file',
      created_by: 'padd config init',
    }
  };

  fs.writeFileSync(targetPath, JSON.stringify(templateConfig, null, 2) + '\n');

  console.log(`\n✅ Created ${filename} at: ${targetPath}\n`);
  console.log(`📋 Next steps:`);
  console.log(`   1. Edit ${filename} and add your configuration`);
  console.log(`   2. Validate: padd config validate`);
  console.log(`   3. Test: padd config show\n`);

  process.exit(0);
}

/**
 * Validate config file
 */
async function configValidate(options = {}) {
  try {
    const config = loadConfig({
      requireWorkspaceConfig: false,
      skipValidation: true, // We'll manually validate
    });

    const configPath = config._meta?.workspaceConfigPath;

    if (!configPath) {
      console.log(`\n⚠️  No config file found in current directory or parents\n`);
      console.log(`💡 Create one: padd config init\n`);
      process.exit(0);
    }

    console.log(`\n✅ Config file is valid: ${configPath}\n`);

    // Check for common issues
    const warnings = [];

    if (!config.version) {
      warnings.push('Missing "version" field');
    }

    if (Object.keys(config).filter(k => !k.startsWith('_')).length <= 1) {
      warnings.push('Config appears empty (only metadata)');
    }

    if (warnings.length > 0) {
      console.log(`⚠️  Warnings:\n`);
      warnings.forEach(w => console.log(`   • ${w}`));
      console.log('');
    }

    process.exit(0);
  } catch (error) {
    console.error(`\n❌ Config validation failed: ${error.message}\n`);
    process.exit(1);
  }
}

/**
 * Show current config
 */
async function configShow(options = {}) {
  const { full = false } = options;

  try {
    const config = loadConfig({
      requireWorkspaceConfig: false,
      skipValidation: true,
    });

    debugConfig(config, { showFull: full });

    process.exit(0);
  } catch (error) {
    console.error(`\n❌ Error loading config: ${error.message}\n`);
    process.exit(1);
  }
}

// ============================================================================
// CLI Router
// ============================================================================

function showHelp() {
  console.log(`
padd config - Configuration Management

USAGE
  padd config <command> [options]

COMMANDS
  init [domain]     Initialize config file
                    Creates config.json (or config.[domain].json)
  
  validate          Validate current config file
                    Checks for syntax errors and common issues
  
  show              Show current configuration
                    Displays loaded config with metadata

OPTIONS
  --force           Force overwrite (init command)
  --full            Show full config object (show command)
  --help, -h        Show this help

EXAMPLES
  # Initialize generic config
  padd config init

  # Initialize domain-specific config
  padd config init talk

  # Validate current config
  padd config validate

  # Show current config with full details
  padd config show --full

CONFIG FILE DISCOVERY
  padd walks up from current directory looking for:
  - config.json
  - config.[domain].json (if domain-specific)
  
  Supports cascading configs:
  1. Default config (lowest priority)
  2. Workspace config (auto-discovered)
  3. CLI-specified config (--config path)
`);
}

export async function run(args) {
  // Parse flags first
  const options = {};
  const positionalArgs = [];
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--force') {
      options.force = true;
    } else if (args[i] === '--full') {
      options.full = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      showHelp();
      process.exit(0);
    } else if (!args[i].startsWith('--')) {
      positionalArgs.push(args[i]);
    }
  }

  const command = positionalArgs[0];

  if (!command) {
    showHelp();
    process.exit(0);
  }

  switch (command) {
    case 'init':
      const domain = positionalArgs[1];
      await configInit(domain, options);
      break;

    case 'validate':
      await configValidate(options);
      break;

    case 'show':
      await configShow(options);
      break;

    default:
      console.error(`\n❌ Unknown command: ${command}`);
      console.error(`   Run: padd config --help\n`);
      process.exit(1);
  }
}

// Allow direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2)).catch(err => {
    console.error(`\n❌ Error: ${err.message}\n`);
    process.exit(1);
  });
}
