# PADD — Confluence Reference

Command reference, shortcodes, and markdown syntax for the `padd confluence` subcommand.

---

## Commands

### Git-like staging workflow

```bash
# Stage files for the next push
padd confluence add .                    # all tracked files
padd confluence add home.md             # specific file
padd confluence add knowledge/          # directory

# Unstage
padd confluence remove home.md

# Show local status (staged / modified / new / deleted / behind remote)
padd confluence status

# Update remote version cache without downloading files
padd confluence fetch

# Push staged files to Confluence
padd confluence push

# Push a specific file regardless of staging
padd confluence push home.md

# Push and skip hash check (force re-upload unchanged files)
padd confluence push --force

# Remove remote pages with no local .md counterpart (like git push --prune)
# Does NOT push any content — only deletes orphaned Confluence pages
padd confluence push --prune
```

### Pull

```bash
# Pull a full space (requires .confluence.yaml in current dir)
padd confluence pull

# Pull a single page by ID
padd confluence pull 928781002

# Pull and overwrite local changes
padd confluence pull --force

# Pull but skip existing local files
padd confluence pull --no-overwrite
```

### Other

```bash
# Initialize a new space folder with .confluence.yaml
padd confluence init SPACENAME ./local-folder
```

---

## Config: `.confluence.yaml`

Place at the root of your local space folder. PADD searches upward from the current file.

```yaml
base_url: https://your-confluence.example.com
token:    YOUR-PERSONAL-ACCESS-TOKEN
space:    SPACEKEY
root_page_id: 123456789   # optional — used as parent for new top-level pages
debug:    false
```

---

## GitHub Alerts → Confluence Panels

Write standard GitHub Alert syntax in your `.md` files. PADD converts them to Confluence panels on push, and pulls them back as alerts.

| Markdown syntax | Confluence panel | Color |
|---|---|---|
| `> [!NOTE]` | info | Blue |
| `> [!TIP]` | tip | Green |
| `> [!IMPORTANT]` | note | Yellow |
| `> [!WARNING]` | warning | Red |
| `> [!CAUTION]` | warning | Red |

**Example:**

```markdown
> [!NOTE]
> This page is maintained by the platform team.
> See [how-we-work.md](how-we-work.md) for details.

> [!WARNING]
> Deprecated as of Q2 2026. Use the new onboarding flow instead.
```

**Rules:**
- Each line of the body must start with `> `
- Blank line between `>` lines splits into multiple `<p>` tags
- Inline markdown in the body (bold, italic, links, inline code) is converted to HTML
- Do NOT nest alerts inside each other

---

## Shortcodes `{{...}}`

Inject Confluence macros that have no markdown equivalent. Written as `{{macro-name param="value"}}` anywhere on its own line or inline.

### Supported shortcodes



#### Table of Contents

```markdown
{{toc}}
```

With params (all params are passed through to Confluence as-is):

```markdown
{{toc maxLevel="3" minLevel="2"}}
```

#### Children Display

Lists child pages of the current page.

```markdown
{{children}}
{{children depth="2"}}
{{children all="true" depth="3"}}
```

#### Status Badge

Inline status label (shows as colored badge in Confluence).

```markdown
{{status label="Done" color="Green"}}
{{status label="In Progress" color="Yellow"}}
{{status label="Blocked" color="Red"}}
{{status label="Review" color="Blue"}}
{{status label="Cancelled" color="Grey"}}
```

Color values (case-sensitive): `Green`, `Yellow`, `Red`, `Blue`, `Grey`

#### Any Confluence Macro

Any `ac:structured-macro` can be expressed as a shortcode. Unknown macros are passed through with params as `ac:parameter` elements:

```markdown
{{jira key="PROJ-123"}}
{{recently-updated}}
{{space-details}}
{{page-tree}}
```

---

## Emoji Codes `:emojicode:`

GitHub-style emoji codes are converted to Unicode on push. Confluence stores and displays Unicode characters natively.

```markdown
Ship it :rocket: :tada:
Review needed :eyes:
Blocked :no_entry:
```

**Skipped inside code spans and fenced code blocks.**

### Supported codes

| Code | Emoji | Code | Emoji |
|---|---|---|---|
| `:+1:` | 👍 | `:-1:` | 👎 |
| `:smile:` | 😊 | `:laughing:` | 😄 |
| `:wink:` | 😉 | `:heart:` | ❤️ |
| `:fire:` | 🔥 | `:rocket:` | 🚀 |
| `:star:` | ⭐ | `:sparkles:` | ✨ |
| `:tada:` | 🎉 | `:muscle:` | 💪 |
| `:eyes:` | 👀 | `:wave:` | 👋 |
| `:warning:` | ⚠️ | `:white_check_mark:` | ✅ |
| `:x:` | ❌ | `:information_source:` | ℹ️ |
| `:bulb:` | 💡 | `:memo:` | 📝 |
| `:pencil:` | ✏️ | `:hammer:` | 🔨 |
| `:wrench:` | 🔧 | `:bug:` | 🐛 |
| `:lock:` | 🔒 | `:key:` | 🔑 |
| `:calendar:` | 📅 | `:hourglass:` | ⏳ |
| `:zap:` | ⚡ | `:check:` | ✔️ |
| `:exclamation:` | ❗ | `:question:` | ❓ |
| `:no_entry:` | ⛔ | `:no_entry_sign:` | 🚫 |
| `:construction:` | 🚧 | `:link:` | 🔗 |
| `:book:` | 📖 | `:books:` | 📚 |
| `:computer:` | 💻 | `:phone:` | 📱 |
| `:email:` | 📧 | `:bell:` | 🔔 |
| `:rotating_light:` | 🚨 | `:boom:` | 💥 |
| `:snowflake:` | ❄️ | `:recycle:` | ♻️ |
| `:dart:` | 🎯 | `:trophy:` | 🏆 |
| `:gem:` | 💎 | `:thinking:` | 🤔 |
| `:clap:` | 👏 | `:pray:` | 🙏 |
| `:100:` | 💯 | `:sos:` | 🆘 |
| `:ok_hand:` | 👌 | `:raised_hand:` | ✋ |

For the full GitHub emoji list: [github.com/ikatyang/emoji-cheat-sheet](https://github.com/ikatyang/emoji-cheat-sheet)

---

## Verbatim Blocks `<!--[CONFLUENCE]-->`

For any Confluence XML that has no markdown equivalent and no shortcode, use a verbatim block. PADD preserves the original XML on push and shows a markdown fallback on pull.

```markdown
<!--[CONFLUENCE]
<ac:structured-macro ac:name="my-custom-macro" ac:schema-version="1">
  <ac:parameter ac:name="someParam">value</ac:parameter>
</ac:structured-macro>
-->
Optional markdown fallback visible in editors
<!--[/CONFLUENCE]-->
```

Or without a fallback (verbatim-only):

```markdown
<!--[CONFLUENCE]
<ac:structured-macro ac:name="my-macro"/>
-->
```

**Note:** The `-->` sequence inside the XML is automatically escaped to `--·>` during pull and restored on push.

---

## Page Headers

Every `.md` file managed by PADD must have these HTML comment headers at the top:

```markdown
<!-- Space: SPACEKEY -->
<!-- Title: Page Title Here -->
<!-- PageId: 123456789 -->
```

- `PageId` is written automatically on first push and used for updates
- `Parent` header is optional and injected by PADD based on folder structure for new pages
- Do not move or rename the `<!-- PageId: -->` comment — PADD uses it to locate the page

---

## Round-trip Summary

| Markdown syntax | Confluence storage | Direction |
|---|---|---|
| `> [!NOTE]` ... | `<ac:structured-macro ac:name="info">` | ↕ both |
| `> [!TIP]` ... | `<ac:structured-macro ac:name="tip">` | ↕ both |
| `> [!IMPORTANT]` ... | `<ac:structured-macro ac:name="note">` | ↕ both |
| `> [!WARNING]` ... | `<ac:structured-macro ac:name="warning">` | ↕ both |
| `{{toc}}` | `<ac:structured-macro ac:name="toc">` | ↕ both |
| `{{children depth="2"}}` | `<ac:structured-macro ac:name="children">` | ↕ both |
| `{{status label="X" color="Y"}}` | `<ac:structured-macro ac:name="status">` | ↕ both |
| `:+1:` | `👍` (Unicode) | → push only |
| `<!--[CONFLUENCE]-->` XML | original XML verbatim | ↕ both |
| ` ```js ` code block | `<ac:structured-macro ac:name="code">` | ↕ both |
| ` ```mermaid ` block | `<ac:structured-macro ac:name="mermaid">` | ↕ both |
| `[text](page.md)` | `<ac:link><ri:page .../>` | ↕ both |
| `[~~Title~~]()` | `<ac:link><ri:page .../>` (unresolved) | → push only |

---

## Tests

```bash
npm test                  # run all snapshot tests
npm run test:update       # regenerate snapshots after intentional changes
node test/run.mjs --filter panel    # run only tests matching "panel"
node test/run.mjs --verbose         # show unchanged context lines in diffs
```

Fixtures live in `test/fixtures/`. Each test is a pair:
- `name.in.html` or `name.in.md` — input
- `name.snap.md` — expected output (auto-generated, commit alongside code changes)
