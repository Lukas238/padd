# padd

**Personal Access Display Device** - Context-aware CLI for operational automation

> Inspired by Star Trek: The Next Generation's PADD devices - your personal interface for managing operations.

## Quick Start

```bash
# Install globally
npm install -g padd

# Initialize authentication
cd ~/Work/my-repo/
padd init

# Use domain commands
cd talks/my-series/
padd talk video-archive --date 2026-04-17
```

## Features

- 🎯 **Context-Aware**: Automatically detects your location and available commands
- 🔐 **Secure**: Built-in encryption support with git-crypt detection
- 🔧 **Extensible**: Add custom domains and commands
- 📚 **Well-Documented**: Comprehensive help at every level
- ⚡ **Fast**: Minimal overhead, instant help commands

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

### Domain Commands (context-specific)

Domain commands are discovered automatically based on your current location.

```bash
cd talks/my-series/
padd talk video-archive --date 2026-04-17
padd talk publish-confluence --date 2026-04-17
```

## Architecture

`padd` is designed as a CLI framework:

- **Generic Libraries**: Reusable API clients (Confluence, SharePoint, etc.)
- **Core Commands**: Authentication, configuration management
- **Utility Commands**: Direct access to low-level operations
- **Domain Discovery**: Automatically finds and loads domain-specific commands

## Libraries

Import `padd` libraries in your custom scripts:

```javascript
import { ConfluenceClient } from 'padd/lib/confluence-client.js';
import { SharePointClient } from 'padd/lib/sharepoint-client.js';
import { loadAuthFile } from 'padd/lib/auth-storage.js';

// Your custom logic...
const auth = loadAuthFile();
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
- [Contributing](./CONTRIBUTING.md) - How to extend

## License

MIT © 2026 Lucas Dasso
