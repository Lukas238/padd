# @lukas238/padd

**Personal Access Data Delivery** — CLI toolkit for syncing Markdown files with Confluence.

> Inspired by Star Trek: The Next Generation's PADD devices.

## Quick Start

```bash
npm install -g @lukas238/padd

# Authenticate
padd auth init

# Initialize a Confluence space in a local folder
cd ~/Work/my-repo/knowledge/MY-SPACE/
padd confluence init MY-SPACE

# Pull all pages
padd confluence pull --all

# Push a file
padd confluence push home.md
```

## Commands

### Auth

```bash
padd auth init                    # Interactive credential setup
padd auth refresh confluence      # Refresh Confluence token
```

### Confluence Sync

```bash
padd confluence init [SPACE]      # Create .confluence.yaml in current folder
padd confluence pull [--all]      # Pull updated pages from Confluence
padd confluence pull <page-id>    # Pull a specific page by ID
padd confluence push <file|dir>   # Push one file or all files in a directory
padd confluence push <file> --include-childs  # Push file + all child pages
padd confluence sync              # Pull then push (two-way sync)
```

### Config

```bash
padd config init                  # Initialize config file
padd config validate              # Validate current config
```

## Confluence Sync

### `.confluence.yaml`

Place this file at the root of your space folder:

```yaml
base_url: https://confluence.example.com
token: YOUR-PAT
space: MYSPACE
root_page_id: 123456
```

### Page headers

Every `.md` file must start with Confluence metadata headers:

```markdown
<!-- Space: MYSPACE -->
<!-- Parent: Parent Page Title -->
<!-- Title: My Page Title -->
<!-- PageId: 123456 -->
```

### Folder structure

Pages follow the hierarchy of the folder structure. A page `home.md` with children in `home/` maps to a Confluence parent/child tree:

```
home.md                     → Home
home/who-we-are.md          → Home > Who We Are
home/standards.md           → Home > Standards
```

### Same-space page links

Use relative `.md` links to link between pages in the same space. They are automatically converted to `<ac:link>` macros on push:

```markdown
See [Our Standards](home/standards.md) for details.
```

If a page exists in Confluence but hasn't been pulled locally yet, pull produces a **disabled link** using strikethrough — it round-trips correctly on push:

```markdown
- [~~Our Standards~~]()
```

### Confluence macros (verbatim blocks)

For macros that have no Markdown equivalent, wrap the raw Confluence XML in a verbatim block. The XML is preserved through pull→edit→push round-trips:

```markdown
<!--[CONFLUENCE]
<ac:structured-macro ac:name="recently-updated" ac:schema-version="1" ac:macro-id="...">
  <ac:parameter ac:name="max">5</ac:parameter>
</ac:structured-macro>
-->
`confluence-macro: recently-updated`
<!--[/CONFLUENCE]-->
```

The second form (without the closing `<!--[/CONFLUENCE]-->`) is for verbatim-only blocks with no Markdown fallback.

**Two-phase push**: `mark` (the Markdown→Confluence converter) never sees the raw XML. PADD extracts verbatim blocks before calling mark, then restores them via the API after mark pushes the page.

### Macro conversion on pull

| Macro | Markdown output |
|---|---|
| `code` | ` ```lang ... ``` ` |
| `info`, `note`, `tip`, `warning` | `> blockquote` |
| `expand` / `details` | inline content |
| `mermaid` | ` ```mermaid ... ``` ` |
| `toc` | `<!-- Table of Contents -->` |
| `children` | `<!-- Child Pages -->` |
| unknown / navigation macros | `` `confluence-macro: name` `` |

## Libraries

```javascript
import { ConfluenceClient, loadAuth } from '@lukas238/padd';

const { auth } = loadAuth();
const client = new ConfluenceClient(auth.providers.confluence);
```

## Security

- Auth files use `.enc.` suffix (`auth.enc.json`) — excluded from git or encrypted via git-crypt
- Sensitive files auto-chmod to 600
- See [SECURITY.md](./SECURITY.md)

## License

MIT © 2026 Lucas Dasso
