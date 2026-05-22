/**
 * md-preprocess.js
 *
 * Markdown preprocessing for the push pipeline.
 * Converts GitHub-flavored markdown patterns into Confluence XML verbatim blocks
 * (<!--[CONFLUENCE]--> wrappers) so the rest of the push pipeline can handle them.
 *
 * Exported:
 *   preprocessMarkdown(md)       - main entry point, runs all three conversions
 *   convertEmojiCodes(md)        - :emoji_code: → Unicode
 *   convertGitHubAlerts(md)      - > [!NOTE] etc. → panel macros
 *   convertShortcodes(md)        - {{macro-name param="val"}} → structured macros
 *   EMOJI_CODES                  - the emoji map (exported for tests/docs)
 *
 * @module lib/md-preprocess
 */

// ─── Emoji ────────────────────────────────────────────────────────────────────

/**
 * Curated emoji code → Unicode map.
 * Only known codes are substituted to avoid false positives on arbitrary :word: patterns.
 */
export const EMOJI_CODES = {
  '+1': '👍', '-1': '👎', 'thumbsup': '👍', 'thumbsdown': '👎',
  'smile': '😊', 'laughing': '😄', 'wink': '😉', 'heart': '❤️',
  'fire': '🔥', 'rocket': '🚀', 'star': '⭐', 'sparkles': '✨',
  'tada': '🎉', 'muscle': '💪', 'clap': '👏', 'pray': '🙏',
  'eyes': '👀', 'wave': '👋', 'point_right': '👉',
  'warning': '⚠️', 'white_check_mark': '✅', 'x': '❌',
  'information_source': 'ℹ️', 'bulb': '💡', 'memo': '📝',
  'pencil': '✏️', 'hammer': '🔨', 'wrench': '🔧',
  'bug': '🐛', 'lock': '🔒', 'key': '🔑',
  'calendar': '📅', 'hourglass': '⏳', 'zap': '⚡',
  'check': '✔️', 'exclamation': '❗', 'question': '❓',
  'no_entry': '⛔', 'no_entry_sign': '🚫', 'construction': '🚧',
  'link': '🔗', 'book': '📖', 'books': '📚',
  'chart_with_upwards_trend': '📈', 'chart_with_downwards_trend': '📉',
  'computer': '💻', 'phone': '📱', 'email': '📧',
  'inbox_tray': '📥', 'outbox_tray': '📤',
  'rotating_light': '🚨', 'bell': '🔔', 'boom': '💥',
  'snowflake': '❄️', 'recycle': '♻️', 'dart': '🎯',
  'trophy': '🏆', 'gem': '💎', 'crystal_ball': '🔮',
  'thinking': '🤔', '100': '💯', 'sos': '🆘',
  'ok_hand': '👌', 'raised_hand': '✋',
};

/**
 * Replace :emoji_code: with Unicode characters.
 * Skips content inside fenced code blocks and inline code spans.
 */
export function convertEmojiCodes(md) {
  const parts = md.split(/(```[\s\S]*?```|`[^`]+`)/);
  return parts.map((part, i) => {
    if (i % 2 === 1) return part; // inside code — skip
    return part.replace(/:([a-zA-Z0-9_+\-]+):/g, (match, code) => EMOJI_CODES[code] || match);
  }).join('');
}

// ─── GitHub Alerts → Confluence Panels ───────────────────────────────────────

/**
 * Convert inline markdown to basic Confluence storage HTML.
 * Used for panel body content when converting GitHub Alerts → panels.
 */
function mdInlineToHtml(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

// GitHub Alert type → Confluence panel macro name
const ALERT_TO_PANEL = {
  NOTE: 'info', TIP: 'tip', IMPORTANT: 'note', WARNING: 'warning', CAUTION: 'warning',
};

/**
 * Convert GitHub Alert syntax → Confluence panel macros (as <!--[CONFLUENCE]--> verbatim blocks).
 *
 * Mapping:
 *   > [!NOTE]       → info panel    (blue)
 *   > [!TIP]        → tip panel     (green)
 *   > [!IMPORTANT]  → note panel    (yellow)
 *   > [!WARNING]    → warning panel (red)
 *   > [!CAUTION]    → warning panel (red)
 *
 * Panel body: inline markdown (bold, italic, code, links) is converted to HTML.
 * Multi-paragraph bodies (blank line inside the alert) produce multiple <p> tags.
 */
export function convertGitHubAlerts(md) {
  return md.replace(
    /^> \[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\n((?:^>[ \t]?[^\n]*\n?)*)/gm,
    (_, type, rawBody) => {
      const panelName = ALERT_TO_PANEL[type];
      const lines = rawBody.split('\n').map(l => l.replace(/^>[ \t]?/, ''));
      while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
      const content = lines.join('\n');
      const paragraphs = content.split(/\n\n+/)
        .map(p => p.trim()).filter(Boolean)
        .map(p => `<p>${mdInlineToHtml(p.replace(/\n/g, ' '))}</p>`)
        .join('\n');
      const xml = `<ac:structured-macro ac:name="${panelName}" ac:schema-version="1">\n<ac:rich-text-body>\n${paragraphs}\n</ac:rich-text-body>\n</ac:structured-macro>`;
      return `<!--[CONFLUENCE]\n${xml}\n-->`;
    }
  );
}

// ─── Shortcodes → Confluence Macros ──────────────────────────────────────────

/**
 * Build Confluence structured-macro XML from a shortcode name + params string.
 *
 * Param name mappings for status macro (shortcode-friendly → Confluence storage):
 *   label → title
 *   color → colour
 */
export function shortcodeToXml(name, paramsStr) {
  const STATUS_PARAM_MAP = { label: 'title', color: 'colour' };
  const params = [];
  for (const [, k, v] of (paramsStr || '').matchAll(/([\w-]+)="([^"]*)"/g)) {
    const xmlKey = name === 'status' && STATUS_PARAM_MAP[k] ? STATUS_PARAM_MAP[k] : k;
    const safeV = v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    params.push(`<ac:parameter ac:name="${xmlKey}">${safeV}</ac:parameter>`);
  }
  if (params.length === 0) return `<ac:structured-macro ac:name="${name}" ac:schema-version="1"/>`;
  return `<ac:structured-macro ac:name="${name}" ac:schema-version="1">\n${params.join('\n')}\n</ac:structured-macro>`;
}

/**
 * Convert {{shortcode-name param="val"}} → Confluence macro XML (as verbatim blocks).
 *
 * Examples:
 *   {{toc}}                              → table of contents macro
 *   {{children depth="2"}}              → children display macro with depth param
 *   {{status label="Done" color="Green"}} → status macro
 *   {{jira key="PROJ-123"}}             → Jira issue macro
 */
export function convertShortcodes(md) {
  return md.replace(/\{\{([\w-]+)((?:\s+[\w-]+=(?:"[^"]*"|\S+))*)\s*\}\}/g, (_, name, paramsStr) => {
    const xml = shortcodeToXml(name, paramsStr);
    return `<!--[CONFLUENCE]\n${xml}\n-->`;
  });
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * Preprocess markdown before push.
 * Runs in order: emoji codes → GitHub Alerts → shortcodes.
 * Must be called before extractVerbatimBlocks in the push pipeline.
 */
export function preprocessMarkdown(md) {
  md = convertEmojiCodes(md);
  md = convertGitHubAlerts(md);
  md = convertShortcodes(md);
  return md;
}
