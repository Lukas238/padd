#!/usr/bin/env node

/**
 * padd auth - Authentication Management
 *
 * Commands:
 *   padd auth init              Initialize auth.enc.json
 *   padd auth refresh <provider> Refresh credentials interactively
 *   padd auth list              List configured providers
 *   padd auth info              Show auth file info
 *
 * @module commands/auth
 */

import fs from 'fs';
import path from 'path';
import { 
  findAuthPath, 
  loadAuth, 
  saveAuth, 
  listProviders,
  checkFilePermissions 
} from '../lib/auth-storage.js';
import { refreshProvider, refreshInteractive } from '../lib/auth-refresh.js';

// ============================================================================
// Command Handlers
// ============================================================================

/**
 * Initialize auth.enc.json file
 */
async function authInit(options = {}) {
  const { force = false } = options;
  const targetPath = path.join(process.cwd(), 'auth.enc.json');

  // Check if already exists
  if (fs.existsSync(targetPath) && !force) {
    console.error(`\n❌ auth.enc.json already exists at: ${targetPath}`);
    console.error(`   Use --force to overwrite\n`);
    process.exit(1);
  }

  // Create empty auth file with new format
  const initialAuth = {
    providers: {},
    _meta: {
      version: '1.0',
      created_at: new Date().toISOString(),
    }
  };

  saveAuth(targetPath, initialAuth);

  console.log(`\n✅ Created auth.enc.json at: ${targetPath}\n`);
  console.log(`📋 Next steps:`);
  console.log(`   1. Add credentials: padd auth refresh <provider>`);
  console.log(`   2. Set permissions: chmod 600 auth.enc.json`);
  console.log(`   3. Optionally encrypt with git-crypt\n`);
  console.log(`🔑 Available providers: ms-graph, confluence, aws, github\n`);

  process.exit(0);
}

/**
 * Refresh provider credentials
 */
async function authRefresh(provider, options = {}) {
  try {
    if (!provider) {
      // Interactive mode
      await refreshInteractive();
    } else {
      // Direct provider refresh
      await refreshProvider(provider, { silent: false });
    }

    console.log(`\n✨ Credentials updated successfully!\n`);
    process.exit(0);
  } catch (error) {
    console.error(`\n❌ Refresh failed: ${error.message}\n`);
    process.exit(1);
  }
}

/**
 * List configured providers
 */
async function authList(options = {}) {
  try {
    const { auth, authPath } = loadAuth({ required: true });

    console.log(`\n📁 Auth File: ${authPath}\n`);

    const providers = listProviders(auth);

    if (providers.length === 0) {
      console.log(`⚠️  No providers configured yet\n`);
      console.log(`💡 Add credentials: padd auth refresh <provider>\n`);
      process.exit(0);
    }

    console.log(`🔑 Configured Providers (${providers.length}):\n`);
    providers.forEach(name => {
      console.log(`   • ${name}`);
    });
    console.log('');

    process.exit(0);
  } catch (error) {
    console.error(`\n❌ Error: ${error.message}\n`);
    process.exit(1);
  }
}

/**
 * Show detailed auth file info
 */
async function authInfo(options = {}) {
  try {
    const { auth, authPath } = loadAuth({ required: true });

    console.log(`\n📁 Auth File Info`);
    console.log(`${'─'.repeat(60)}`);
    console.log(`Path: ${authPath}`);
    console.log(`Version: ${auth._meta?.version || 'legacy'}`);

    if (auth._meta?.created_at) {
      console.log(`Created: ${auth._meta.created_at}`);
    }

    if (auth._meta?.last_updated) {
      console.log(`Updated: ${auth._meta.last_updated}`);
    }

    const permCheck = checkFilePermissions(authPath);
    console.log(`Secure: ${permCheck.secure ? '✅' : '⚠️'} (mode: ${permCheck.mode})`);

    if (!permCheck.secure) {
      console.log(`\n⚠️  Permissions Warning:`);
      permCheck.warnings.forEach(w => console.log(`   ${w}`));
      console.log(`   Run: chmod 600 ${authPath}`);
    }

    const providers = listProviders(auth);
    console.log(`\n🔑 Providers (${providers.length}):`);
    console.log(`${'─'.repeat(60)}`);

    if (providers.length === 0) {
      console.log(`   (none configured)\n`);
    } else {
      providers.forEach(name => {
        const provider = auth.providers[name];
        console.log(`\n${name}:`);

        if (provider._updated_at) {
          console.log(`  Last Updated: ${provider._updated_at}`);
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
      });
      console.log('');
    }

    process.exit(0);
  } catch (error) {
    console.error(`\n❌ Error: ${error.message}\n`);
    process.exit(1);
  }
}

// ============================================================================
// CLI Router
// ============================================================================

function showHelp() {
  console.log(`
padd auth - Authentication Management

USAGE
  padd auth <command> [options]

COMMANDS
  init              Initialize auth.enc.json file
  refresh [provider] Refresh credentials (interactive if no provider)
  list              List configured providers
  info              Show detailed auth file info

PROVIDERS
  ms-graph          Microsoft Graph API (OAuth token)
  confluence        Atlassian Confluence (API Token/PAT)
  aws               Amazon Web Services (Access Key)
  github            GitHub (Personal Access Token)

OPTIONS
  --force           Force overwrite (init command)
  --help, -h        Show this help

EXAMPLES
  # Initialize auth file
  padd auth init

  # Refresh Microsoft Graph token (interactive)
  padd auth refresh ms-graph

  # Refresh any provider (interactive selection)
  padd auth refresh

  # List all configured providers
  padd auth list

  # Show detailed auth info
  padd auth info
`);
}

export async function run(args) {
  // Parse flags first
  const options = {};
  const positionalArgs = [];
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--force') {
      options.force = true;
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
      await authInit(options);
      break;

    case 'refresh':
      const provider = positionalArgs[1];
      await authRefresh(provider, options);
      break;

    case 'list':
      await authList(options);
      break;

    case 'info':
      await authInfo(options);
      break;

    default:
      console.error(`\n❌ Unknown command: ${command}`);
      console.error(`   Run: padd auth --help\n`);
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
