/**
 * confluence-converter.js
 *
 * Converts Confluence storage format (XHTML) to Markdown.
 * Pure JS, zero dependencies.
 *
 * Supports:
 *   - ac:structured-macro: code, info, note, warning, tip, expand, mermaid, toc, children
 *   - ac:image + ri:attachment → markdown images
 *   - ac:link + ri:page → markdown links
 *   - Standard HTML: h1-h6, p, ul/ol/li, table, a, strong, em, code, pre, br, hr, blockquote
 *
 * @module lib/confluence-converter
 */

// ─── HTML Entities ────────────────────────────────────────────────────────────

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function escapeMarkdown(str) {
  // Escape markdown special chars in plain text (not in code blocks)
  return str.replace(/([\\`*_{}[\]()#+\-.!|])/g, '\\$1');
}

// ─── Round-trip Preservation ──────────────────────────────────────────────────

/**
 * Wrap a converted element with the original Confluence XML preserved in an
 * HTML comment. This enables lossless round-trips: pull → edit → push.
 *
 * Format (with markdown):
 *   <!--[CONFLUENCE]
 *   <ac:original-xml/>
 *   -->
 *   ...markdown representation...
 *   <!--[/CONFLUENCE]-->
 *
 * Format (no markdown equivalent, verbatim preservation only):
 *   <!--[CONFLUENCE]
 *   <ac:original-xml/>
 *   -->
 *
 * The '-->' sequence in original XML is escaped to '--\u00B7>' to avoid
 * breaking HTML comment syntax. Restored automatically on push.
 */
function wrapConfluence(original, markdown) {
  const safe = original.replace(/-->/g, '--\u00B7>');
  const md = (markdown || '').trim();
  if (!md) return `<!--[CONFLUENCE]\n${safe}\n-->`;
  return `<!--[CONFLUENCE]\n${safe}\n-->\n${md}\n<!--[/CONFLUENCE]-->`;
}

// ─── Emoticons ────────────────────────────────────────────────────────────────

const EMOTICON_MAP = {
  smile: '😊', sad: '😞', cheeky: '😛', laugh: '😁', wink: '😉',
  'thumbs-up': '👍', 'thumbs-down': '👎', information: 'ℹ️',
  tick: '✅', cross: '❌', warning: '⚠️',
};

function convertEmoticons(html) {
  return html.replace(/<ac:emoticon\s+ac:name="([^"]+)"\s*\/>/g, (_, name) =>
    EMOTICON_MAP[name] || `(${name})`
  );
}

// ─── Task Lists ───────────────────────────────────────────────────────────────

function convertTaskLists(html, baseUrl, pageId) {
  return html.replace(/<ac:task-list>([\s\S]*?)<\/ac:task-list>/g, (_, body) => {
    const tasks = [];
    for (const [, inner] of body.matchAll(/<ac:task>([\s\S]*?)<\/ac:task>/g)) {
      const status = (inner.match(/<ac:task-status>([^<]*)<\/ac:task-status>/) || [])[1]?.trim() || 'incomplete';
      const taskBodyHtml = (inner.match(/<ac:task-body>([\s\S]*?)<\/ac:task-body>/) || [])[1] || '';
      const taskBodyMd = storageToMarkdown(taskBodyHtml, { baseUrl, pageId }).trim();
      tasks.push(`- ${status === 'complete' ? '[x]' : '[ ]'} ${taskBodyMd}`);
    }
    return tasks.length ? '\n' + tasks.join('\n') + '\n' : '\n';
  });
}

// ─── Page Layouts ─────────────────────────────────────────────────────────────

function convertLayouts(html) {
  // Strip layout/section wrappers; keep cell content with blank-line separation.
  let result = html;
  let prev;
  do {
    prev = result;
    result = result
      .replace(/<ac:layout-cell[^>]*>([\s\S]*?)<\/ac:layout-cell>/g, '\n$1\n')
      .replace(/<ac:layout-section[^>]*>([\s\S]*?)<\/ac:layout-section>/g, '$1')
      .replace(/<ac:layout[^>]*>([\s\S]*?)<\/ac:layout>/g, '$1');
  } while (result !== prev);
  return result;
}

// ─── Anchors & Placeholders ───────────────────────────────────────────────────

function convertAnchors(html) {
  return html
    .replace(/<ac:anchor>([\s\S]*?)<\/ac:anchor>/g, (_, name) => `<a name="${name.trim()}"></a>`)
    .replace(/<ac:anchor\s[^>]*\/>/g, '');
}

function convertPlaceholders(html) {
  return html.replace(
    /<ac:placeholder[^>]*>([\s\S]*?)<\/ac:placeholder>/g,
    (_, text) => `_${text.trim()}_`
  );
}

// ─── Macro Conversion ─────────────────────────────────────────────────────────

const PANEL_LABELS = {
  info:    'ℹ️ Info',
  note:    '📝 Note',
  tip:     '💡 Tip',
  warning: '⚠️ Warning',
};

function extractMacroParam(body, name) {
  const re = new RegExp(`<ac:parameter[^>]*ac:name="${name}"[^>]*>([\\s\\S]*?)<\\/ac:parameter>`);
  const m = body.match(re);
  return m ? decodeEntities(m[1].trim()) : null;
}

function extractCdata(body) {
  const m = body.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return m ? m[1] : null;
}

function extractRichTextBody(body) {
  const m = body.match(/<ac:rich-text-body>([\s\S]*?)<\/ac:rich-text-body>/);
  return m ? m[1].trim() : null;
}

function convertMacro(name, body) {
  switch (name) {
    case 'code': {
      const lang = extractMacroParam(body, 'language') || '';
      const code = extractCdata(body) || stripAllTags(body);
      return `\n\`\`\`${lang}\n${code.trim()}\n\`\`\`\n`;
    }

    case 'info':
    case 'note':
    case 'tip':
    case 'warning': {
      const label = PANEL_LABELS[name];
      const richBody = extractRichTextBody(body) || body;
      // Convert inner HTML recursively, then prefix each line with >
      const innerMd = storageToMarkdown(richBody).trim();
      const quoted = innerMd.split('\n').map(l => `> ${l}`).join('\n');
      return `\n> **${label}**\n>\n${quoted}\n`;
    }

    case 'expand':
    case 'details': {
      const richBody = extractRichTextBody(body) || body;
      return `\n${storageToMarkdown(richBody).trim()}\n`;
    }

    case 'mermaid-cloud':
    case 'mermaid': {
      const code = extractCdata(body) || extractRichTextBody(body) || '';
      return `\n\`\`\`mermaid\n${code.trim()}\n\`\`\`\n`;
    }

    case 'toc':
      return '\n<!-- Table of Contents -->\n';

    case 'children':
      return '\n<!-- Child Pages -->\n';

    case 'recently-updated':
    case 'space-details':
    case 'page-tree':
      // Navigation macros: no static equivalent — show name as fallback
      return `\n\`confluence-macro: ${name}\`\n`;

    default:
      return `\n\`confluence-macro: ${name}\`\n`;
  }
}

/**
 * Convert all ac:structured-macro elements, inside-out (innermost first).
 */
function convertMacros(html) {
  // Tempered greedy: match innermost macro (no nested ac:structured-macro inside).
  // The alternation <!--[\s\S]*?--> skips over CONFLUENCE wrappers added in
  // previous iterations, preventing infinite re-wrapping of already-wrapped content.
  const re = /<!--[\s\S]*?-->|<ac:structured-macro[^>]*ac:name="([^"]+)"[^>]*>((?:(?!<ac:structured-macro)[\s\S])*?)<\/ac:structured-macro>/g;
  let prev;
  do {
    prev = html;
    html = html.replace(re, (fullMatch, name, body) => {
      if (name === undefined) return fullMatch; // HTML comment — pass through
      const converted = convertMacro(name, body).trim();
      return wrapConfluence(fullMatch, converted);
    });
  } while (html !== prev);
  return html;
}

// ─── Confluence Elements ──────────────────────────────────────────────────────

function convertConfluenceImages(html, baseUrl, pageId) {
  // <ac:image ac:alt="..."><ri:attachment ri:filename="img.png" /></ac:image>
  // <ac:image><ri:url ri:value="https://..." /></ac:image>
  return html.replace(/<ac:image[^>]*>([\s\S]*?)<\/ac:image>/g, (fullMatch, inner) => {
    const filename = (inner.match(/ri:filename="([^"]+)"/) || [])[1];
    const url = (inner.match(/ri:value="([^"]+)"/) || [])[1];
    const alt = (inner.match(/ac:alt="([^"]+)"/) || [])[1] || filename || 'image';
    let src;
    if (url) {
      src = url;
    } else if (filename && baseUrl && pageId) {
      src = `${baseUrl}/download/attachments/${pageId}/${encodeURIComponent(filename)}`;
    } else if (filename) {
      src = `./assets/${filename}`; // fallback if no baseUrl
    } else {
      src = '';
    }
    const md = src ? `![${alt}](${src})` : '';
    return wrapConfluence(fullMatch, md);
  });
}

/**
 * Compute a relative file path from a directory to a target path,
 * both relative to the same root. No external dependencies.
 * @param {string} fromDir  - directory of the current file, e.g. '' or 'home'
 * @param {string} toPath   - target file path relative to root, e.g. 'home/who-we-are.md'
 */
function relativeFromDir(fromDir, toPath) {
  const fromParts = fromDir ? fromDir.split('/').filter(Boolean) : [];
  const toParts = toPath.split('/').filter(Boolean);
  let common = 0;
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
    common++;
  }
  const ups = fromParts.length - common;
  const downs = toParts.slice(common);
  const parts = [...Array(ups).fill('..'), ...downs];
  return parts.length ? parts.join('/') : '.';
}

/**
 * @param {string} html
 * @param {Object|null} titleToRelPath  - map of page title → localPath (relative to spaceRoot)
 * @param {string} currentDir           - directory of the current file relative to spaceRoot
 */
function convertConfluenceLinks(html, titleToRelPath, currentDir) {
  // <ac:link><ri:page ri:content-title="Title" />...
  // <ac:link><ri:attachment ri:filename="doc.pdf" />...
  return html.replace(/<ac:link[^>]*>([\s\S]*?)<\/ac:link>/g, (fullMatch, inner) => {
    const title    = (inner.match(/ri:content-title="([^"]+)"/) || [])[1] || '';
    const filename = (inner.match(/ri:filename="([^"]+)"/)      || [])[1] || '';
    const spaceKey = (inner.match(/ri:space-key="([^"]+)"/)     || [])[1] || '';
    const cdataText = extractCdata(inner);
    const text = cdataText || title || filename || 'link';

    // Same-space page link (no ri:space-key) → always emit a clean markdown link.
    // If the title is in the manifest we use the known relative path.
    // If not, wrap verbatim (so push round-trips correctly) and emit [text]()
    // as the fallback — an empty-href link signals "unresolved page reference"
    // without implying a wrong local path.
    if (title && !spaceKey) {
      if (titleToRelPath && currentDir !== undefined && titleToRelPath[title]) {
        const relLink = relativeFromDir(currentDir, titleToRelPath[title]);
        return `[${text}](${relLink})`;
      }
      // Page not yet in manifest — use confluence: scheme so push can restore the
      // ac:link macro without needing a verbatim wrapper block.
      // Strikethrough signals "unresolved local reference"; slug keeps the URL valid.
      // Link text is always the page title here so push can recover ri:content-title.
      return `[~~${title}~~]()`;
    }

    let md;
    if (title)    md = `[${text}](${title})`;
    else if (filename) md = `[${text}](${filename})`;
    else          md = text;
    return wrapConfluence(fullMatch, md);
  });
}

// ─── Table Conversion ─────────────────────────────────────────────────────────

function convertTables(html) {
  return html.replace(/<table[\s\S]*?<\/table>/g, convertTable);
}

function convertTable(tableHtml) {
  const rows = [];
  let isFirstRow = true;

  for (const trMatch of tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [];
    for (const cellMatch of trMatch[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)) {
      // Strip tags and normalize whitespace inside cell
      const text = stripAllTags(cellMatch[1])
        .replace(/\n+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
      cells.push(text || ' ');
    }
    if (cells.length > 0) rows.push({ cells, isHeader: isFirstRow });
    isFirstRow = false;
  }

  if (rows.length === 0) return '';

  // If only one row, treat as header + empty body
  const header = rows[0].cells;
  const separator = header.map(() => '---');
  const body = rows.slice(1);

  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...body.map(r => `| ${r.cells.join(' | ')} |`),
  ];

  return '\n' + lines.join('\n') + '\n';
}

// ─── Block Element Conversion ─────────────────────────────────────────────────

function convertBlockElements(html) {
  return html
    // Headings
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, c) => `\n# ${stripAllTags(c).trim()}\n`)
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, c) => `\n## ${stripAllTags(c).trim()}\n`)
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, c) => `\n### ${stripAllTags(c).trim()}\n`)
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (_, c) => `\n#### ${stripAllTags(c).trim()}\n`)
    .replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, (_, c) => `\n##### ${stripAllTags(c).trim()}\n`)
    .replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, (_, c) => `\n###### ${stripAllTags(c).trim()}\n`)

    // Blockquote
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, c) => {
      return '\n' + c.trim().split('\n').map(l => `> ${l}`).join('\n') + '\n';
    })

    // Horizontal rule
    .replace(/<hr[^>]*\/?>/gi, '\n---\n')

    // Preformatted (outside of code macro)
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, c) => `\n\`\`\`\n${stripAllTags(c)}\n\`\`\`\n`)

    // Paragraph
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, c) => `\n${c.trim()}\n`)

    // Line breaks
    .replace(/<br\s*\/?>/gi, '\n')

    // Divs and spans — unwrap, keep content
    .replace(/<div[^>]*>([\s\S]*?)<\/div>/gi, (_, c) => `\n${c}\n`)
    .replace(/<span[^>]*>([\s\S]*?)<\/span>/gi, '$1');
}

function convertLists(html) {
  // Process lists recursively (handle nesting)
  let prev;
  do {
    prev = html;
    // Unordered list items
    html = html.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, content) => {
      const items = [];
      for (const li of content.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
        const text = li[1].trim();
        items.push(`- ${text}`);
      }
      return '\n' + items.join('\n') + '\n';
    });
    // Ordered list items
    html = html.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, content) => {
      const items = [];
      let n = 1;
      for (const li of content.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
        const text = li[1].trim();
        items.push(`${n++}. ${text}`);
      }
      return '\n' + items.join('\n') + '\n';
    });
  } while (html !== prev);
  return html;
}

// ─── Inline Element Conversion ────────────────────────────────────────────────

function convertInlineElements(html) {
  return html
    // Bold
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
    .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**')

    // Italic
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*')
    .replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*')

    // Strikethrough
    .replace(/<(?:del|s|strike)[^>]*>([\s\S]*?)<\/(?:del|s|strike)>/gi, '~~$1~~')

    // Inline code
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')

    // Links
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
      const cleanText = stripAllTags(text).trim();
      return cleanText ? `[${cleanText}](${href})` : href;
    })

    // Images
    .replace(/<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi, '![$2]($1)')
    .replace(/<img[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*\/?>/gi, '![$1]($2)')
    .replace(/<img[^>]*src="([^"]*)"[^>]*\/?>/gi, '![]($1)');
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function stripAllTags(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function cleanup(md) {
  return md
    .replace(/\n{4,}/g, '\n\n\n')   // max 2 blank lines
    .replace(/[ \t]+$/gm, '')        // trailing whitespace on lines
    .replace(/^\n+/, '')             // leading newlines
    .replace(/\n+$/, '\n');          // single trailing newline
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * Convert Confluence storage format HTML to Markdown.
 *
 * @param {string} html    - Confluence storage format HTML (body.storage.value)
 * @param {object} [opts]  - Optional context
 * @param {string} [opts.baseUrl] - Confluence base URL (e.g. https://confluence.example.com)
 * @param {string} [opts.pageId]  - Page ID, used to build absolute attachment URLs
 * @returns {string} Markdown string
 */
export function storageToMarkdown(html, opts = {}) {
  if (!html || !html.trim()) return '';

  const { baseUrl, pageId, titleToRelPath, currentRelPath } = opts;
  const currentDir = currentRelPath
    ? (currentRelPath.includes('/') ? currentRelPath.replace(/\/[^/]*$/, '') : '')
    : undefined;
  let result = html;

  // Step 1: Confluence macros (inside-out, handles CDATA internally)
  result = convertMacros(result);

  // Step 2: Confluence images and links
  result = convertConfluenceImages(result, baseUrl, pageId);
  result = convertConfluenceLinks(result, titleToRelPath, currentDir);

  // Step 2.5: Task lists → markdown checkboxes
  result = convertTaskLists(result, baseUrl, pageId);

  // Step 2.6: Page layouts → strip wrappers, keep cell content
  result = convertLayouts(result);

  // Step 2.7: Anchors and instructional placeholders
  result = convertAnchors(result);
  result = convertPlaceholders(result);

  // Step 2.8: Emoticons → Unicode
  result = convertEmoticons(result);

  // Step 3: Tables (before block elements to avoid mangling cell content)
  result = convertTables(result);

  // Step 4: Lists (before block/inline to handle nesting)
  result = convertLists(result);

  // Step 5: Block elements
  result = convertBlockElements(result);

  // Step 6: Inline elements
  result = convertInlineElements(result);

  // Step 6.5: Preserve any remaining Confluence block/inline elements verbatim.
  // Single outside-in pass with comment-skipping to avoid re-wrapping already-
  // wrapped content. No do-while needed: outermost element is matched first.
  result = result.replace(
    /<!--[\s\S]*?-->|<(ac:[a-z][a-z0-9-]*)[^>]*>[\s\S]*?<\/\1>/gi,
    (match, name) => {
      if (name === undefined) return match; // HTML comment — pass through
      return wrapConfluence(match, '');
    }
  );
  // Self-closing ac: and ri: tags not yet handled
  result = result.replace(
    /<!--[\s\S]*?-->|<(?:ac|ri):[a-z][a-z0-9-]*[^>]*\/>/gi,
    (match) => {
      if (match.startsWith('<!--')) return match; // HTML comment — pass through
      return wrapConfluence(match, '');
    }
  );

  // Step 7: Strip any remaining standard HTML tags, skipping CONFLUENCE comments
  // to preserve the original XML stored inside them.
  result = result.replace(
    /<!--[\s\S]*?-->|<[^>]+>/g,
    (match) => (match.startsWith('<!--') ? match : '')
  );

  // Step 8: Decode entities
  result = decodeEntities(result);

  // Step 9: Cleanup whitespace
  return cleanup(result);
}

/**
 * Build mark-compatible headers for a Confluence page.
 *
 * @param {string} space - Space key
 * @param {Array}  ancestors - Array of ancestor page objects {title}
 * @param {string} title - Page title
 * @returns {string} Mark header block
 */
export function buildMarkHeaders(space, ancestors, title) {
  let headers = `<!-- Space: ${space} -->\n`;
  if (ancestors && ancestors.length > 0) {
    const parent = ancestors[ancestors.length - 1].title;
    headers += `<!-- Parent: ${parent} -->\n`;
  }
  headers += `<!-- Title: ${title} -->\n`;
  return headers;
}

/**
 * Slugify a page title for use as a filename.
 *
 * @param {string} title
 * @returns {string}
 */
export function slugifyTitle(title) {
  return title
    .toLowerCase()
    .replace(/[áàäâ]/g, 'a').replace(/[éèëê]/g, 'e')
    .replace(/[íìïî]/g, 'i').replace(/[óòöô]/g, 'o')
    .replace(/[úùüû]/g, 'u').replace(/ñ/g, 'n')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}
