#!/usr/bin/env node

/**
 * padd - Auth Refresh
 *
 * Interactive credential refresh for multiple providers.
 * Called automatically when tokens/credentials expire or need updating.
 *
 * Supported Providers:
 * - ms-graph: Microsoft Graph API (OAuth access token via Graph Explorer)
 * - confluence: Atlassian Confluence (API Token/PAT)
 * - aws: AWS (Access Key ID + Secret Access Key)
 * - github: GitHub (Personal Access Token)
 *
 * Features:
 * - Auto-detects expired tokens
 * - Interactive prompts for credential entry
 * - Updates auth.enc.json with new format
 * - JWT decode for username extraction (Graph)
 * - Extensible provider system
 *
 * @module lib/auth-refresh
 * @version 1.0.0
 * @license MIT
 */

import fs from 'fs';
import { findAuthPath, loadAuthFile, saveAuthFile, updateProvider } from './auth-storage.js';

// ============================================================================
// Provider Refresh Handlers
// ============================================================================

/**
 * Prompt user for input via readline
 */
async function promptUser(question, options = {}) {
  const { password = false } = options;

  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    if (password) {
      // For passwords, we mute the output
      const stdin = process.stdin;
      stdin.on('data', char => {
        const str = char + '';
        switch (str) {
          case '\n':
          case '\r':
          case '\u0004':
            stdin.pause();
            break;
          default:
            process.stdout.clearLine();
            process.stdout.cursorTo(0);
            process.stdout.write(question + '*'.repeat(rl.line.length));
            break;
        }
      });
    }

    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Refresh handler for Microsoft Graph
 */
async function refreshMsGraph(existingCreds, options = {}) {
  const { silent = false } = options;
  
  // Check if existing token is still valid
  if (existingCreds?.access_token && existingCreds?.expires_at) {
    const expiresAt = new Date(existingCreds.expires_at);
    const now = new Date();
    
    // If token expires in more than 5 minutes, reuse it
    if (expiresAt > new Date(now.getTime() + 5 * 60 * 1000)) {
      if (!silent) {
        const timeLeft = Math.round((expiresAt - now) / 1000 / 60);
        console.log(`⏱️  Using existing token (expires in ${timeLeft} minutes)\n`);
      }
      return existingCreds;
    }
  }
  
  const savedUsername = existingCreds?.username;

  if (!silent) {
    console.log("\n📋 Microsoft Graph Token Refresh\n");

    if (savedUsername) {
      console.log(`👤 Account: \x1b[1m${savedUsername}\x1b[0m\n`);
    }

    console.log("Steps to get a new token:\n");
    console.log("   1. Open: https://developer.microsoft.com/en-us/graph/graph-explorer");
    console.log("   2. Sign in with your corporate account");
    console.log("   3. Run any query (e.g., GET /v1.0/me)");
    console.log("   4. Click 'Access Token' tab");
    console.log("   5. Copy the token\n");
  }

  const accessToken = await promptUser('🔑 Paste access token: ');

  if (!accessToken || accessToken.length < 100) {
    throw new Error("Invalid token. Should be a long JWT string.");
  }

  // Extract username from JWT
  let username = savedUsername;
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64').toString());
    username = payload.upn || payload.preferred_username || payload.email || savedUsername || "unknown";
  } catch {
    if (!silent) {
      console.log("⚠️  Could not extract username from token");
    }
    username = savedUsername || "unknown";
  }

  return {
    username,
    access_token: accessToken,
    expires_in: 3600,
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    token_type: "Bearer",
    last_refreshed: new Date().toISOString()
  };
}

/**
 * Refresh handler for Confluence
 */
async function refreshConfluence(existingCreds, options = {}) {
  const { silent = false } = options;

  if (!silent) {
    console.log("\n📋 Confluence Credentials Refresh\n");

    // Detect if it's Cloud or Server/Data Center
    const baseUrl = existingCreds?.base_url || await promptUser('🌐 Confluence Base URL (e.g., https://confluence.uhub.biz): ');
    const isCloud = baseUrl.includes('atlassian.net');

    if (isCloud) {
      console.log("Detected: Atlassian Cloud\n");
      console.log("Steps to get an API token:\n");
      console.log("   1. Open: https://id.atlassian.com/manage-profile/security/api-tokens");
      console.log("   2. Click 'Create API token'");
      console.log("   3. Give it a name (e.g., 'Leadership Ops Scripts')");
      console.log("   4. Copy the token\n");

      const username = existingCreds?.username || await promptUser('👤 Your email: ');
      const apiToken = await promptUser('🔑 API Token: ');

      if (!apiToken || apiToken.length < 10) {
        throw new Error("Invalid API token.");
      }

      return {
        type: 'cloud',
        base_url: baseUrl,
        username,
        api_token: apiToken,
        last_refreshed: new Date().toISOString()
      };
    } else {
      console.log("Detected: Confluence Server/Data Center\n");
      console.log("Steps to get a Personal Access Token (PAT):\n");
      console.log("   1. Open: " + baseUrl + "/plugins/personalaccesstokens/usertokens.action");
      console.log("   2. Click 'Create token'");
      console.log("   3. Give it a name and set permissions");
      console.log("   4. Copy the token (starts with 'NjE...')\n");

      const pat = await promptUser('🔑 Personal Access Token (PAT): ');

      if (!pat || pat.length < 10) {
        throw new Error("Invalid PAT.");
      }

      return {
        type: 'server',
        base_url: baseUrl,
        pat: pat,
        last_refreshed: new Date().toISOString()
      };
    }
  }

  // Silent mode (auto-refresh) - preserve existing type
  const baseUrl = existingCreds?.base_url;
  const isCloud = existingCreds?.type === 'cloud' || (baseUrl && baseUrl.includes('atlassian.net'));

  if (isCloud) {
    // If we have valid existing credentials, return them
    if (existingCreds?.api_token && existingCreds?.username) {
      return {
        type: 'cloud',
        base_url: baseUrl,
        username: existingCreds.username,
        api_token: existingCreds.api_token,
        last_refreshed: new Date().toISOString()
      };
    }

    const username = existingCreds?.username || await promptUser('👤 Your email: ');
    const apiToken = await promptUser('🔑 API Token: ');

    return {
      type: 'cloud',
      base_url: baseUrl,
      username,
      api_token: apiToken,
      last_refreshed: new Date().toISOString()
    };
  } else {
    // If we have valid existing credentials, return them
    if (existingCreds?.pat) {
      return {
        type: 'server',
        base_url: baseUrl,
        pat: existingCreds.pat,
        last_refreshed: new Date().toISOString()
      };
    }

    const pat = await promptUser('🔑 Personal Access Token (PAT): ');

    return {
      type: 'server',
      base_url: baseUrl,
      pat: pat,
      last_refreshed: new Date().toISOString()
    };
  }
}

/**
 * Refresh handler for AWS
 */
async function refreshAws(existingCreds, options = {}) {
  const { silent = false } = options;

  if (!silent) {
    console.log("\n📋 AWS Credentials Refresh\n");
    console.log("Steps to get AWS credentials:\n");
    console.log("   1. Open: https://console.aws.amazon.com/iam/home#/security_credentials");
    console.log("   2. Create new access key (if needed)");
    console.log("   3. Copy Access Key ID and Secret Access Key\n");
  }

  const accessKeyId = await promptUser('🔑 Access Key ID: ');
  const secretAccessKey = await promptUser('🔐 Secret Access Key: ', { password: true });
  const region = existingCreds?.region || await promptUser('\n🌎 Default region (e.g., us-east-1): ') || 'us-east-1';

  if (!accessKeyId || !secretAccessKey) {
    throw new Error("Invalid AWS credentials.");
  }

  return {
    access_key_id: accessKeyId,
    secret_access_key: secretAccessKey,
    region,
    last_refreshed: new Date().toISOString()
  };
}

/**
 * Refresh handler for GitHub
 */
async function refreshGitHub(existingCreds, options = {}) {
  const { silent = false } = options;

  if (!silent) {
    console.log("\n📋 GitHub Personal Access Token Refresh\n");
    console.log("Steps to get a PAT:\n");
    console.log("   1. Open: https://github.com/settings/tokens");
    console.log("   2. Click 'Generate new token' → 'Generate new token (classic)'");
    console.log("   3. Select required scopes (repo, workflow, etc.)");
    console.log("   4. Copy the token\n");
  }

  const token = await promptUser('🔑 Personal Access Token: ');
  const username = existingCreds?.username || await promptUser('👤 GitHub username: ');

  if (!token || token.length < 20) {
    throw new Error("Invalid GitHub token.");
  }

  return {
    username,
    token,
    last_refreshed: new Date().toISOString()
  };
}

// ============================================================================
// Provider Registry
// ============================================================================

const PROVIDERS = {
  'ms-graph': {
    name: 'Microsoft Graph',
    handler: refreshMsGraph,
    description: 'OAuth access token (expires hourly)'
  },
  'confluence': {
    name: 'Atlassian Confluence',
    handler: refreshConfluence,
    description: 'API Token (PAT)'
  },
  'aws': {
    name: 'Amazon Web Services',
    handler: refreshAws,
    description: 'Access Key + Secret'
  },
  'github': {
    name: 'GitHub',
    handler: refreshGitHub,
    description: 'Personal Access Token'
  }
};

// ============================================================================
// Main Refresh Functions
// ============================================================================

/**
 * Refresh credentials for a specific provider
 *
 * @param {string} providerKey - Provider key (e.g., 'ms-graph', 'confluence')
 * @param {Object} options - Refresh options
 * @param {string} options.authPath - Path to auth.enc.json (auto-detected if not provided)
 * @param {boolean} options.silent - Suppress output (default: false)
 * @returns {Promise<Object>} - New credentials
 *
 * @example
 * await refreshProvider('ms-graph');
 * await refreshProvider('confluence', { silent: true });
 */
export async function refreshProvider(providerKey, options = {}) {
  const {
    authPath = findAuthPath(),
    silent = false,
  } = options;

  if (!authPath) {
    throw new Error('auth.enc.json not found. Run from repository root or subdirectory.');
  }

  // Validate provider
  const provider = PROVIDERS[providerKey];
  if (!provider) {
    const available = Object.keys(PROVIDERS).join(', ');
    throw new Error(`Unknown provider: ${providerKey}. Available: ${available}`);
  }

  // Load existing auth
  const auth = loadAuthFile(authPath, { silent: true });
  const existingCreds = auth.providers?.[providerKey];

  if (!silent) {
    console.log(`\n🔄 Refreshing: ${provider.name}\n`);
  }

  // Call provider-specific handler
  const newCreds = await provider.handler(existingCreds, { silent });

  // Update auth file
  const updatedAuth = updateProvider(auth, providerKey, newCreds);
  saveAuthFile(authPath, updatedAuth);

  if (!silent) {
    console.log(`\n✅ ${provider.name} credentials refreshed!`);
  }

  return newCreds;
}

/**
 * Legacy function name for MS Graph (backward compatibility)
 * Returns only the access_token string for convenience
 */
export async function refreshMsGraphToken(options = {}) {
  const creds = await refreshProvider('ms-graph', options);
  return creds.access_token;
}

/**
 * Convenience function for Confluence
 * Returns only the api_token string for convenience
 */
export async function refreshConfluenceToken(options = {}) {
  const creds = await refreshProvider('confluence', options);
  return creds.api_token;
}

/**
 * Interactive provider selection and refresh
 */
export async function refreshInteractive(options = {}) {
  const {
    authPath = findAuthPath(),
  } = options;

  if (!authPath) {
    throw new Error('auth.enc.json not found. Run from repository root or subdirectory.');
  }

  // Load existing auth
  const auth = loadAuthFile(authPath, { silent: true });

  console.log("\n🔐 Credential Refresh\n");
  console.log("Available providers:\n");

  const providerKeys = Object.keys(PROVIDERS);
  providerKeys.forEach((key, index) => {
    const provider = PROVIDERS[key];
    const hasExisting = auth.providers?.[key] ? '✓' : ' ';
    console.log(`   ${index + 1}. [${hasExisting}] ${provider.name} - ${provider.description}`);
  });

  console.log("\n   0. Cancel\n");

  const choice = await promptUser('Select provider (1-' + providerKeys.length + '): ');
  const choiceNum = parseInt(choice);

  if (choiceNum === 0 || isNaN(choiceNum)) {
    console.log("Cancelled.");
    return null;
  }

  if (choiceNum < 1 || choiceNum > providerKeys.length) {
    throw new Error("Invalid choice.");
  }

  const providerKey = providerKeys[choiceNum - 1];
  return refreshProvider(providerKey, { authPath });
}

// ============================================================================
// CLI Mode
// ============================================================================

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);

  // Parse provider from CLI args
  let providerKey = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--provider' || args[i] === '-p') {
      providerKey = args[++i];
    }
  }

  try {
    if (providerKey) {
      // Direct provider refresh
      await refreshProvider(providerKey);
    } else {
      // Interactive mode
      await refreshInteractive();
    }

    console.log("\n✨ Ready! Your scripts can now use the updated credentials.\n");
    process.exit(0);
  } catch (err) {
    console.error("\n❌ Credential refresh failed:", err.message);
    console.error("\n💡 Usage:");
    console.error("   node auth-refresh.js              # Interactive mode");
    console.error("   node auth-refresh.js -p ms-graph  # Refresh specific provider\n");
    console.error("📋 Available providers:");
    Object.keys(PROVIDERS).forEach(key => {
      console.error(`   - ${key}: ${PROVIDERS[key].name}`);
    });
    console.error();
    process.exit(1);
  }
}
