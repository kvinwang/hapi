/**
 * Markdown → HTML for the low-power UI, rendered on the hub.
 *
 * `marked` is used purely as a *tokenizer*; every tag in the output is emitted by the
 * walker below. That is the whole security argument: markdown here carries agent output,
 * which routinely contains file contents, web pages and command output, so it must be
 * treated as hostile. Rather than parse to HTML and then try to sanitize it back
 * (marked ships no sanitizer, and DOMPurify needs a DOM), nothing from the source is
 * ever emitted as markup:
 *
 * - Text is escaped at every leaf. The tag set is closed and defined here.
 * - Raw HTML tokens are escaped and shown literally, so `<script>` reads as text.
 * - Link targets are scheme-checked; anything but http/https/mailto/relative degrades
 *   to plain text, which kills `javascript:` and `data:` URLs.
 * - Images render as links rather than `<img>`: an old tablet on a metered connection
 *   should not silently fetch remote bytes, and it sidesteps tracking pixels.
 *
 * Rendering server-side means the client pays nothing — no markdown bundle, no parsing
 * per streamed update, which is exactly what makes the SPA expensive on this device.
 */

import { Marked, type Token, type Tokens } from 'marked'
import { escapeHtml } from '../routes/sharePage'

/**
 * A private instance so these options cannot leak into any other consumer.
 *
 * `breaks` matches the SPA's `remarkBreaks`: agents emit single newlines as real line
 * breaks, and CommonMark's "collapse to a space" turns their output into wall-of-text.
 *
 * The `code` tokenizer — indented code blocks, not fenced ones — is disabled for the
 * same reason the SPA disables it: LLM prose is full of incidentally indented lines,
 * and every one of them would otherwise render as a code block.
 */
const parser = new Marked({
    gfm: true,
    breaks: true,
    tokenizer: {
        code() { return undefined }
    }
})

/** Past this, parsing stops earning its keep; show the raw text instead. */
const MAX_SOURCE_LENGTH = 200_000

const SAFE_SCHEMES = ['http:', 'https:', 'mailto:']

/**
 * A link target we are willing to put in an `href`.
 *
 * Relative and anchor links are fine. Absolute ones must carry a known-safe scheme —
 * `javascript:`, `data:` and friends fall through to null and get rendered as text.
 */
function safeHref(href: string): string | null {
    const trimmed = href.trim()
    if (!trimmed) return null

    // Control characters are how `java\nscript:` style bypasses are smuggled in.
    if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null

    if (trimmed.startsWith('#') || trimmed.startsWith('/')) return trimmed
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return trimmed

    try {
        return SAFE_SCHEMES.includes(new URL(trimmed).protocol) ? trimmed : null
    } catch {
        return null
    }
}

/** Matches `&` only when it does not already begin a character reference. */
const BARE_AMPERSAND = /&(?!#\d{1,7};|#[Xx][a-fA-F0-9]{1,6};|[a-zA-Z][a-zA-Z0-9]{1,31};)/g

/**
 * Escape prose from markdown, leaving existing character references intact.
 *
 * Markdown treats `&amp;` in prose as a reference to `&`, so escaping it again shows the
 * reader the literal `&amp;`. Only the `&` handling differs from full escaping: `<` and
 * `>` are still always escaped, and an entity cannot introduce markup — the browser
 * renders `&lt;script&gt;` as text — so nothing is weakened here.
 *
 * Deliberately not used for code spans or fences, where CommonMark does not recognise
 * character references and the literal `&amp;` is what the author meant, nor for
 * attribute values, which need full escaping.
 */
function escapeMarkdownText(text: string): string {
    return text
        .replace(BARE_AMPERSAND, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

function renderInline(tokens: Token[] | undefined): string {
    if (!tokens) return ''
    return tokens.map(renderInlineToken).join('')
}

function renderInlineToken(token: Token): string {
    switch (token.type) {
        case 'text': {
            const t = token as Tokens.Text
            // `text` tokens carry nested tokens when they contain inline markup.
            return t.tokens ? renderInline(t.tokens) : escapeMarkdownText(t.text)
        }
        case 'escape':
            // A backslash escape resolves to one literal character; it is not prose that
            // could contain a character reference.
            return escapeHtml((token as Tokens.Text).text)
        case 'strong':
            return `<strong>${renderInline((token as Tokens.Strong).tokens)}</strong>`
        case 'em':
            return `<em>${renderInline((token as Tokens.Em).tokens)}</em>`
        case 'del':
            return `<del>${renderInline((token as Tokens.Del).tokens)}</del>`
        case 'codespan':
            return `<code>${escapeHtml((token as Tokens.Codespan).text)}</code>`
        case 'br':
            return '<br>'
        case 'link': {
            const t = token as Tokens.Link
            const href = safeHref(t.href)
            const label = renderInline(t.tokens) || escapeHtml(t.text)
            if (!href) return label
            return `<a href="${escapeHtml(href)}" rel="noopener noreferrer nofollow" target="_blank">${label}</a>`
        }
        case 'image': {
            const t = token as Tokens.Image
            const href = safeHref(t.href)
            const label = escapeHtml(t.text || t.title || '图片')
            if (!href) return label
            return `<a href="${escapeHtml(href)}" rel="noopener noreferrer nofollow" target="_blank">🖼 ${label}</a>`
        }
        case 'html':
            // Shown literally rather than emitted — see the file header.
            return escapeHtml((token as Tokens.HTML).text)
        case 'checkbox':
            // Emitted from the list item's own `checked` flag; the token would
            // otherwise fall through and repeat the literal "[x] ".
            return ''
        default:
            return escapeHtml((token as { raw?: string }).raw ?? '')
    }
}

function renderListItems(token: Tokens.List): string {
    return token.items.map((item) => {
        const body = renderBlockTokens(item.tokens ?? [])
        if (!item.task) return `<li>${body}</li>`
        // Rendered as a disabled box: this is a transcript, not a form.
        return `<li class="task">${item.checked ? '☑' : '☐'} ${body}</li>`
    }).join('')
}

function renderTable(token: Tokens.Table): string {
    const head = token.header.map((cell) => `<th>${renderInline(cell.tokens)}</th>`).join('')
    const body = token.rows.map((row) =>
        `<tr>${row.map((cell) => `<td>${renderInline(cell.tokens)}</td>`).join('')}</tr>`
    ).join('')
    return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
}

function renderBlockToken(token: Token): string {
    switch (token.type) {
        case 'space':
            return ''
        case 'heading': {
            const t = token as Tokens.Heading
            // Clamped to h3-h6 so a message cannot outrank the page's own headings.
            const level = Math.min(6, Math.max(3, t.depth + 2))
            return `<h${level}>${renderInline(t.tokens)}</h${level}>`
        }
        case 'paragraph':
            return `<p>${renderInline((token as Tokens.Paragraph).tokens)}</p>`
        case 'text': {
            const t = token as Tokens.Text
            return t.tokens ? renderInline(t.tokens) : escapeMarkdownText(t.text)
        }
        case 'code':
            return `<pre>${escapeHtml((token as Tokens.Code).text)}</pre>`
        case 'blockquote':
            return `<blockquote>${renderBlockTokens((token as Tokens.Blockquote).tokens)}</blockquote>`
        case 'list': {
            const t = token as Tokens.List
            if (!t.ordered) return `<ul>${renderListItems(t)}</ul>`
            const start = typeof t.start === 'number' && t.start !== 1 ? ` start="${t.start}"` : ''
            return `<ol${start}>${renderListItems(t)}</ol>`
        }
        case 'table':
            return renderTable(token as Tokens.Table)
        case 'hr':
            return '<hr>'
        case 'html':
            return `<p>${escapeHtml((token as Tokens.HTML).text)}</p>`
        default:
            return renderInlineToken(token)
    }
}

function renderBlockTokens(tokens: Token[]): string {
    return tokens.map(renderBlockToken).join('')
}

/** Escaped, newline-preserving plain text — the fallback and the user-message path. */
export function renderPlainText(text: string): string {
    return `<div class="text">${escapeHtml(text)}</div>`
}

/**
 * Render agent-authored markdown to a closed set of safe tags.
 *
 * Falls back to plain text on oversized input or any parser error: a broken message
 * should degrade to something readable, never to a broken page.
 */
export function renderMarkdown(source: string): string {
    if (!source) return ''
    if (source.length > MAX_SOURCE_LENGTH) return renderPlainText(source)

    try {
        const tokens = parser.lexer(source)
        const html = renderBlockTokens(tokens)
        return html ? `<div class="md">${html}</div>` : ''
    } catch {
        return renderPlainText(source)
    }
}
