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

# Pull Excel sheets from SharePoint
padd excel pull
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

### Excel Sync (SharePoint)

```bash
padd excel init                   # Create local .padd.yaml in current folder
padd excel clone schedule.csv --sheet Schedule --sharing-url "https://..."  # first download
padd excel pull schedule.csv      # update from remote using CSV metadata
padd excel push schedule.csv      # push local changes using CSV metadata
padd excel clone --sheet Schedule --sharing-url "https://..."  # defaults to schedule.csv
padd excel pull schedule.csv --drive-id "b!..." --item-id "01..."  # metadata override
```

Preferred config strategy: keep a local config file in the same directory as
your CSV files (for example `schedule.csv`). PADD will walk ancestor folders
until it finds one config file.

Create `.padd.yaml`:

```yaml
sharepoint:
  access_token: "eyJ0eXAiOi..."
```

PADD searches upward from the current directory for:

- `.padd.yaml`
- `.padd.yml`
- `padd.yaml`
- `padd.yml`
- `config.talk.json` (backward-compatible fallback)

Notes:
- Core settings are namespaced by parent keys (`sharepoint`, `confluence`) to avoid token mixups.
- Excel sync does not refresh tokens automatically. If token is expired, command fails and you refresh manually.
- URL/sheet mapping is file-by-file via CSV comments (FastCSV-style `#`) and CLI flags, not config.
- Preferred critical metadata per CSV: BrowserURL, Workbook, Sheet, DriveId, ItemId.

Workflow model:
- `clone` = first download for a specific file/sheet pair
- `pull <file>` = refresh that same file from remote
- `push <file>` = publish local edits for that file

### Talk Workflow

```bash
padd talk init --space WUNARGCAPABILITY --parent-page-id 123456 --series-title "WSSC Talks" --series-key WSSC
padd talk new --talk 7
padd talk new --date 2026-05-28
padd talk video --talk 7 --video-url "https://..."
padd talk page --talk 7
padd talk page --date 2026-05-28
```

Optional `.padd.yaml` section for talks:

```yaml
talk:
  prefix: WSSC
confluence:
  talk:
    space: WUNARGCAPABILITY
    parent_page_id: "123456"
```

Talk flow model:
- `init` = set/update `.padd.yaml` + create local root/archive/year pages + store SharePoint archive URL only
- `new` = generate temporary announcements for personal comms (uses `announcements.tmpl.md` at config root if present, otherwise generic fallback)
- `video` = update processed video URL in `schedule.csv` and, when possible, resolve/cache SharePoint archive IDs from the saved folder URL
- `page` = upsert local talk page in `confluence/archive - <PREFIX>/<YEAR - PREFIX>/` from `talks.csv` (uses `page.tmpl.md` if present, otherwise generic fallback)
- `announcements` remains as alias of `new`
- `create` and `publish` remain as deprecated aliases to `page`

Conventions:
- Talks source file defaults to `talks.csv` at the same root directory where `.padd.yaml` lives.
- Confluence markdown tree is always created under `confluence/` to avoid mixing with operational files in root.
- `init` creates `talks.csv` if missing (copies `schedule.csv` if present, otherwise writes headers).

CSV comment example:

```text
sharepoint:
  talk:
    video_archive:
      share_url: "https://wppcloud.sharepoint.com/:f:/s/..."
# BrowserURL: https://wppcloud.sharepoint.com/...
# Workbook: Dev Talks - Wanna See Something Cool_.xlsx
# Sheet: Schedule
# DriveId: b!ABC...
# ItemId: 01XYZ...
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
