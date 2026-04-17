# padd Architecture

## Overview

`padd` is a context-aware CLI framework designed for operational automation. It follows a layered architecture with clear separation between generic infrastructure and domain-specific logic.

## Design Principles

1. **Generic Core, Specific Domains**: Core libraries are 100% generic and publishable. Domain logic stays in private repos.

2. **Context-Awareness**: Automatically discovers available commands based on workspace location.

3. **Progressive Disclosure**: Simple commands are simple to use. Advanced features available when needed.

4. **Zero Lock-in**: All libraries importable independently. Not forced to use the CLI.

## Architecture Layers

```
┌─────────────────────────────────────────────────────────────┐
│                    CLI Executable (padd)                    │
│                   Context-aware dispatcher                  │
└─────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│  Core Commands   │ │ Utility Commands │ │ Domain Commands  │
│  (auth, config)  │ │  (utils/*)       │ │ (auto-discovered)│
└──────────────────┘ └──────────────────┘ └──────────────────┘
          │                   │                   │
          └───────────────────┼───────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Generic Libraries                        │
│  auth-storage, auth-refresh, config-loader,                │
│  confluence-client, sharepoint-client                       │
└─────────────────────────────────────────────────────────────┘
```

## Command Types

### Core Commands (Global)
- **Purpose**: Authentication and configuration management
- **Location**: `commands/auth.js`, `commands/config.js`
- **Availability**: Always available, anywhere
- **Examples**: `padd auth refresh`, `padd config validate`

### Utility Commands (Direct API Access)
- **Purpose**: Low-level API operations without domain logic
- **Location**: `commands/utils/*.js`
- **Availability**: Always available
- **Examples**: `padd utils confluence create-page`, `padd utils sharepoint list`

### Domain Commands (Context-Specific)
- **Purpose**: High-level workflows for specific domains
- **Location**: External workspaces with padd metadata
- **Availability**: Auto-discovered based on current directory
- **Examples**: `padd talk video-archive`, `padd report generate`

## Library Architecture

### `lib/auth-storage.js`
- Auth file discovery (upward directory walk)
- Load/save with atomic writes
- Permission checking
- Format normalization (legacy → new)
- Provider CRUD operations

### `lib/auth-refresh.js`
- Interactive credential prompts
- Provider-specific refresh handlers
- JWT parsing (MS Graph username extraction)
- Token expiration tracking

### `lib/config-loader.js`
- Config file discovery (upward walk)
- Cascading merge (default → workspace → CLI)
- Deep object merging
- Pluggable validation
- Debug utilities

### `lib/confluence-client.js`
- REST API wrapper (Cloud + Server/Data Center)
- Page CRUD operations
- Attachment management (upload, update)
- Smart upsert (create or update)
- Automatic auth header management

### `lib/sharepoint-client.js`
- MS Graph API wrapper
- File/folder operations (list, get, move, copy, delete)
- Video metadata updates
- Search functionality
- Site drive support

## File Discovery Pattern

All infrastructure uses **upward directory walk**:

```javascript
// Searches from current directory up to filesystem root
findAuthPath({ startDir: process.cwd() })
findConfigPath({ startDir: process.cwd() })
```

**Benefits**:
- Works from any subdirectory
- No need to remember file locations
- Supports monorepo structures
- Respects workspace boundaries

## Security Model

### Auth Files (auth.enc.json)
1. **Suffix Convention**: `.enc.` indicates sensitive data
2. **Permissions**: Automatically checks for chmod 600
3. **Optional Encryption**: Works with or without git-crypt
4. **Atomic Writes**: Prevents corruption
5. **Backup on Save**: Creates .backup file

### Config Files (config.json)
- Safe to commit (no sensitive data)
- Domain-specific naming: `config.{domain}.json`
- Supports environment-specific configs

## Extension Pattern

### Adding a New Provider

```javascript
// In auth-refresh.js
const PROVIDERS = {
  'my-provider': {
    name: 'My Service',
    handler: refreshMyProvider,
    description: 'API Key authentication'
  }
};

async function refreshMyProvider(existingCreds, options) {
  // Implement provider-specific logic
  return { api_key: '...', last_refreshed: '...' };
}
```

### Adding a New Utility Command

```javascript
// Create commands/utils/my-service.js
export async function run(args) {
  const command = args[0];
  
  switch (command) {
    case 'list':
      // Implement list logic
      break;
    // ... more commands
  }
}
```

### Adding a Domain

In your private repo:

```json
// package.json
{
  "name": "my-project",
  "padd": {
    "domain": "mydomain",
    "commands": {
      "action": "./scripts/action.js"
    }
  }
}
```

Domain discovery coming in Phase 2.

## Testing Strategy

1. **Unit Tests**: Each library tested independently
2. **Integration Tests**: Command workflows end-to-end
3. **Manual Testing**: CLI UX validation
4. **npm link**: Local testing before publish

## Distribution

- **Public Package**: `npm install -g padd`
- **Private Domains**: Installed via `npm install padd` in workspace
- **Zero Config**: Works immediately after install

## Future Enhancements

- Domain autodiscovery (Phase 2)
- Interactive command builder
- Telemetry (opt-in)
- Plugin system
- Better error messages with recovery suggestions
