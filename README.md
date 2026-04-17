# @lukas238/padd

**Personal Access Data Delivery** - Connection helpers and utilities for operational automation

> Inspired by Star Trek: The Next Generation's PADD devices - your personal toolkit for accessing data platforms.

## Quick Start

```bash
# Install globally
npm install -g @lukas238/padd

# Or install in your project
npm install @lukas238/padd

# Initialize authentication
cd ~/Work/my-repo/
padd auth init

# Use in your scripts
import { loadAuth, ConfluenceClient } from '@lukas238/padd';
const { auth } = loadAuth();
const confluence = new ConfluenceClient(auth.providers.confluence);
```

## Features

- 🔌 **Connection Helpers**: Ready-to-use clients for Confluence and SharePoint
- 🔐 **Secure Auth**: Built-in credential management with encryption support (git-crypt)
- 🔧 **Importable Libraries**: Use just what you need in your scripts
- 📦 **Batteries Included**: Auth refresh, config validation, utility functions
- ⚡ **Minimal Dependencies**: Lightweight and fast

## Core Commands

### Global Commands (available everywhere)

```bash
padd auth init              # Setup authentication
padd auth refresh <provider> # Refresh credentials
padd config init            # Initialize configuration
padd config validate        # Validate current config
```

### Utility Commands (advanced)

```bash
padd utils confluence create-page --space KEY --title "Title"
padd utils sharepoint upload --file data.xlsx
```

## What is PADD?

`padd` is a collection of connection helpers and utilities:

- **Generic Libraries**: Reusable API clients (Confluence, SharePoint)
- **Auth Management**: Secure credential storage and refresh logic
- **Config Utilities**: Configuration loading and validation
- **CLI Tools**: Optional command-line interface for auth/config operations

The libraries are the core product. The CLI provides convenient access to auth and config commands.

## Libraries

Import `@lukas238/padd` libraries in your custom scripts:

```javascript
// Convenient: import from main module
import { ConfluenceClient, SharePointClient, loadAuth } from '@lukas238/padd';

// Or explicit: import from specific modules
import { ConfluenceClient } from '@lukas238/padd/lib/confluence-client.js';

// Usage
const { auth } = loadAuth();
const client = new ConfluenceClient(auth.providers.confluence);
```

## Security

- Auth files use `.enc.` suffix (`auth.enc.json`)
- Auto chmod 600 on sensitive files
- git-crypt detection and warnings
- Conditional .gitignore management

## Documentation

- [Architecture](./ARCHITECTURE.md) - System design
- [Security](./SECURITY.md) - Security considerations

## License

MIT © 2026 Lucas Dasso
