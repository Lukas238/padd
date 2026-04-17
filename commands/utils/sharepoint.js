#!/usr/bin/env node

/**
 * padd utils sharepoint - Direct SharePoint/OneDrive API Access
 *
 * Low-level utility commands for SharePoint/OneDrive operations via MS Graph.
 * For use when you need direct API access without domain logic.
 *
 * @module commands/utils/sharepoint
 */

import { SharePointClient } from '../../lib/sharepoint-client.js';
import { getProviderCredentials } from '../../lib/auth-storage.js';

// ============================================================================
// Command Handlers
// ============================================================================

async function listFiles(folderId) {
  try {
    const creds = getProviderCredentials('ms-graph');
    if (!creds) {
      console.error(`\n❌ Microsoft Graph credentials not found`);
      console.error(`   Run: padd auth refresh ms-graph\n`);
      process.exit(1);
    }

    const client = new SharePointClient({
      accessToken: creds.access_token,
    });

    const endpoint = folderId ? `listChildren` : 'root';
    const result = folderId 
      ? await client.listChildren(folderId)
      : await client.request('/me/drive/root/children');

    console.log(`\n📁 Files and Folders:\n`);

    result.value.forEach(item => {
      const icon = item.folder ? '📁' : '📄';
      const size = item.size ? ` (${(item.size / 1024).toFixed(1)} KB)` : '';
      console.log(`   ${icon} ${item.name}${size}`);
      if (item.id) {
        console.log(`      ID: ${item.id}`);
      }
    });

    console.log('');
    process.exit(0);
  } catch (error) {
    console.error(`\n❌ Failed to list files: ${error.message}\n`);
    process.exit(1);
  }
}

async function getFile(itemId) {
  if (!itemId) {
    console.error(`\n❌ Missing item ID\n`);
    process.exit(1);
  }

  try {
    const creds = getProviderCredentials('ms-graph');
    if (!creds) {
      console.error(`\n❌ Microsoft Graph credentials not found`);
      console.error(`   Run: padd auth refresh ms-graph\n`);
      process.exit(1);
    }

    const client = new SharePointClient({
      accessToken: creds.access_token,
    });

    const item = await client.getById(itemId);

    console.log(`\n📄 Item Info:`);
    console.log(`   Name: ${item.name}`);
    console.log(`   ID: ${item.id}`);
    console.log(`   Type: ${item.folder ? 'Folder' : 'File'}`);
    if (item.size) {
      console.log(`   Size: ${(item.size / 1024).toFixed(1)} KB`);
    }
    if (item.createdDateTime) {
      console.log(`   Created: ${item.createdDateTime}`);
    }
    if (item.lastModifiedDateTime) {
      console.log(`   Modified: ${item.lastModifiedDateTime}`);
    }
    if (item.webUrl) {
      console.log(`   URL: ${item.webUrl}`);
    }
    console.log('');

    process.exit(0);
  } catch (error) {
    console.error(`\n❌ Failed to get item: ${error.message}\n`);
    process.exit(1);
  }
}

async function searchFiles(query) {
  if (!query) {
    console.error(`\n❌ Missing search query\n`);
    process.exit(1);
  }

  try {
    const creds = getProviderCredentials('ms-graph');
    if (!creds) {
      console.error(`\n❌ Microsoft Graph credentials not found`);
      console.error(`   Run: padd auth refresh ms-graph\n`);
      process.exit(1);
    }

    const client = new SharePointClient({
      accessToken: creds.access_token,
    });

    const result = await client.search(query);

    console.log(`\n🔍 Search Results for "${query}":\n`);

    if (!result.value || result.value.length === 0) {
      console.log(`   No results found\n`);
      process.exit(0);
    }

    result.value.forEach(item => {
      const icon = item.folder ? '📁' : '📄';
      console.log(`   ${icon} ${item.name}`);
      console.log(`      ID: ${item.id}`);
      if (item.webUrl) {
        console.log(`      URL: ${item.webUrl}`);
      }
    });

    console.log('');
    process.exit(0);
  } catch (error) {
    console.error(`\n❌ Search failed: ${error.message}\n`);
    process.exit(1);
  }
}

// ============================================================================
// CLI Router
// ============================================================================

function showHelp() {
  console.log(`
padd utils sharepoint - Direct SharePoint/OneDrive API Access

USAGE
  padd utils sharepoint <command> [options]

COMMANDS
  list [folder-id]  List files in folder (or root if no ID)
  get <item-id>     Get item information by ID
  search <query>    Search for files by name

EXAMPLES
  # List files in root
  padd utils sharepoint list

  # List files in specific folder
  padd utils sharepoint list 01ABCDEF123456789

  # Get item info
  padd utils sharepoint get 01ABCDEF123456789

  # Search for files
  padd utils sharepoint search "meeting notes"

NOTES
  - Requires MS Graph credentials (padd auth refresh ms-graph)
  - Access token expires in ~1 hour
  - For complex workflows, use domain commands instead
  - Item IDs can be found in URLs or via list command
`);
}

export async function run(args) {
  const command = args[0];

  if (!command || args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }

  switch (command) {
    case 'list':
      const folderId = args[1];
      await listFiles(folderId);
      break;

    case 'get':
      const itemId = args[1];
      await getFile(itemId);
      break;

    case 'search':
      const query = args.slice(1).join(' ');
      await searchFiles(query);
      break;

    default:
      console.error(`\n❌ Unknown command: ${command}`);
      console.error(`   Run: padd utils sharepoint --help\n`);
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
