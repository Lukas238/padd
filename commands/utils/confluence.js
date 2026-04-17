#!/usr/bin/env node

/**
 * padd utils confluence - Direct Confluence API Access
 *
 * Low-level utility commands for Confluence operations.
 * For use when you need direct API access without domain logic.
 *
 * @module commands/utils/confluence
 */

import { ConfluenceClient } from '../../lib/confluence-client.js';
import { getProviderCredentials } from '../../lib/auth-storage.js';

// ============================================================================
// Command Handlers
// ============================================================================

async function createPage(options) {
  const { space, title, body, parent } = options;

  if (!space || !title) {
    console.error(`\n❌ Missing required options: --space and --title\n`);
    process.exit(1);
  }

  try {
    const creds = getProviderCredentials('confluence');
    if (!creds) {
      console.error(`\n❌ Confluence credentials not found`);
      console.error(`   Run: padd auth refresh confluence\n`);
      process.exit(1);
    }

    const client = new ConfluenceClient({
      baseUrl: creds.base_url,
      username: creds.username,
      apiToken: creds.api_token,
      pat: creds.pat,
      type: creds.type,
    });

    const pageBody = body || `<p>Page created by padd at ${new Date().toISOString()}</p>`;

    const page = await client.createPage({
      spaceKey: space,
      title,
      body: pageBody,
      parentId: parent,
    });

    console.log(`\n✅ Page created successfully!`);
    console.log(`   ID: ${page.id}`);
    console.log(`   Title: ${page.title}`);
    console.log(`   URL: ${creds.base_url}/wiki${page._links.webui}\n`);

    process.exit(0);
  } catch (error) {
    console.error(`\n❌ Failed to create page: ${error.message}\n`);
    process.exit(1);
  }
}

async function getPage(pageId) {
  if (!pageId) {
    console.error(`\n❌ Missing page ID\n`);
    process.exit(1);
  }

  try {
    const creds = getProviderCredentials('confluence');
    if (!creds) {
      console.error(`\n❌ Confluence credentials not found`);
      console.error(`   Run: padd auth refresh confluence\n`);
      process.exit(1);
    }

    const client = new ConfluenceClient({
      baseUrl: creds.base_url,
      username: creds.username,
      apiToken: creds.api_token,
      pat: creds.pat,
      type: creds.type,
    });

    const page = await client.getPage(pageId);

    console.log(`\n📄 Page Info:`);
    console.log(`   ID: ${page.id}`);
    console.log(`   Title: ${page.title}`);
    console.log(`   Version: ${page.version.number}`);
    console.log(`   Space: ${page.space?.key || 'N/A'}`);
    console.log(`   URL: ${creds.base_url}/wiki${page._links.webui}\n`);

    process.exit(0);
  } catch (error) {
    console.error(`\n❌ Failed to get page: ${error.message}\n`);
    process.exit(1);
  }
}

// ============================================================================
// CLI Router
// ============================================================================

function showHelp() {
  console.log(`
padd utils confluence - Direct Confluence API Access

USAGE
  padd utils confluence <command> [options]

COMMANDS
  create-page       Create a new Confluence page
  get-page <id>     Get page information by ID

CREATE PAGE OPTIONS
  --space <key>     Space key (required)
  --title <title>   Page title (required)
  --body <html>     Page body (HTML storage format)
  --parent <id>     Parent page ID (optional)

EXAMPLES
  # Create a simple page
  padd utils confluence create-page \\
    --space VMLDEVHUB \\
    --title "Test Page"

  # Create page with custom body
  padd utils confluence create-page \\
    --space VMLDEVHUB \\
    --title "My Page" \\
    --body "<p>Custom content</p>"

  # Create child page
  padd utils confluence create-page \\
    --space VMLDEVHUB \\
    --title "Child Page" \\
    --parent 123456

  # Get page info
  padd utils confluence get-page 123456

NOTES
  - Requires Confluence credentials (padd auth refresh confluence)
  - Body must be valid Confluence storage format (HTML-like)
  - For complex workflows, use domain commands instead
`);
}

export async function run(args) {
  const command = args[0];

  if (!command || args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }

  // Parse options
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].substring(2);
      const value = args[i + 1];
      options[key] = value;
      i++; // Skip next arg
    }
  }

  switch (command) {
    case 'create-page':
      await createPage(options);
      break;

    case 'get-page':
      const pageId = args[1];
      await getPage(pageId);
      break;

    default:
      console.error(`\n❌ Unknown command: ${command}`);
      console.error(`   Run: padd utils confluence --help\n`);
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
