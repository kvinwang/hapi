import { describe, expect, it } from 'bun:test'
import { renderMarkdown, renderPlainText } from './markdown'

/**
 * Markdown here renders agent output — file contents, fetched pages, command output.
 * It is the only place in the lite UI where untrusted text becomes markup, so the
 * injection cases carry more weight than the formatting ones.
 */

describe('markdown formatting', () => {
    it('renders the common blocks', () => {
        expect(renderMarkdown('**bold** and *em* and `code`'))
            .toContain('<strong>bold</strong>')
        expect(renderMarkdown('**bold** and *em* and `code`'))
            .toContain('<em>em</em>')
        expect(renderMarkdown('**bold** and *em* and `code`'))
            .toContain('<code>code</code>')
    })

    it('renders fenced code as plain preformatted text, not highlighted markup', () => {
        const html = renderMarkdown('```js\nconst a = 1\n```')
        expect(html).toContain('<pre>const a = 1')
        expect(html).not.toContain('<span')
    })

    it('renders nested lists', () => {
        const html = renderMarkdown('- a\n  - b\n- c')
        expect(html).toContain('<ul>')
        expect(html.match(/<ul>/g)?.length).toBe(2)
        expect(html).toContain('<li>')
    })

    it('renders ordered lists and honours a non-default start', () => {
        expect(renderMarkdown('1. a\n2. b')).toContain('<ol>')
        expect(renderMarkdown('5. a\n6. b')).toContain('<ol start="5">')
    })

    it('renders GFM tables', () => {
        const html = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |')
        expect(html).toContain('<table>')
        expect(html).toContain('<th>a</th>')
        expect(html).toContain('<td>1</td>')
    })

    it('renders task lists as non-interactive marks', () => {
        const html = renderMarkdown('- [x] done\n- [ ] todo')
        expect(html).toContain('☑')
        expect(html).toContain('☐')
        // A transcript must not contain form controls.
        expect(html).not.toContain('<input')
        // marked emits a separate checkbox token; letting it through would repeat
        // the literal marker next to the one we render.
        expect(html).not.toContain('[x]')
        expect(html).not.toContain('[ ]')
        expect(html).toContain('☑ done')
    })

    it('renders blockquotes, rules and strikethrough', () => {
        expect(renderMarkdown('> quoted')).toContain('<blockquote>')
        expect(renderMarkdown('---')).toContain('<hr>')
        expect(renderMarkdown('~~gone~~')).toContain('<del>gone</del>')
    })

    it('demotes headings so a message cannot outrank the page chrome', () => {
        expect(renderMarkdown('# top')).toContain('<h3>top</h3>')
        expect(renderMarkdown('###### deep')).toContain('<h6>deep</h6>')
        expect(renderMarkdown('# top')).not.toContain('<h1>')
    })

    it('returns nothing for empty input', () => {
        expect(renderMarkdown('')).toBe('')
    })

    it('keeps single newlines as line breaks, as the SPA does', () => {
        // CommonMark would collapse these to a space and turn agent output into a wall.
        const html = renderMarkdown('line one\nline two')
        expect(html).toContain('<br>')
        expect(html).toContain('line two')
    })

    it('does not treat indented prose as a code block', () => {
        // LLM output is full of incidentally indented lines; the SPA disables this too.
        const html = renderMarkdown('Some text:\n\n    indented continuation')
        expect(html).not.toContain('<pre>')
        expect(html).toContain('indented continuation')
    })

    it('still renders fenced code as code', () => {
        expect(renderMarkdown('```\nx = 1\n```')).toContain('<pre>x = 1')
    })

    it('falls back to plain text on oversized input instead of parsing it', () => {
        const huge = 'x'.repeat(200_001)
        const html = renderMarkdown(huge)
        expect(html).toContain('class="text"')
        expect(html).not.toContain('class="md"')
    })
})

describe('markdown injection', () => {
    it('shows raw HTML literally instead of emitting it', () => {
        const html = renderMarkdown('<script>alert(1)</script>')
        expect(html).not.toContain('<script>')
        expect(html).toContain('&lt;script&gt;')
    })

    it('neutralises inline raw HTML', () => {
        const html = renderMarkdown('text <img src=x onerror=alert(1)> more')
        expect(html).not.toContain('<img')
        expect(html).toContain('&lt;img')
    })

    it('does not emit an href for javascript: links', () => {
        const html = renderMarkdown('[click](javascript:alert(1))')
        expect(html).not.toContain('javascript:')
        expect(html).not.toContain('<a ')
        expect(html).toContain('click')
    })

    it('does not emit an href for data: links', () => {
        const html = renderMarkdown('[x](data:text/html;base64,PHNjcmlwdD4=)')
        expect(html).not.toContain('<a ')
        expect(html).not.toContain('data:text/html')
    })

    it('rejects control-character obfuscated schemes', () => {
        expect(renderMarkdown('[x](java\tscript:alert(1))')).not.toContain('<a ')
        expect(renderMarkdown('[x](  javascript:alert(1))')).not.toContain('<a ')
    })

    it('is not fooled by uppercase or mixed-case schemes', () => {
        expect(renderMarkdown('[x](JaVaScRiPt:alert(1))')).not.toContain('<a ')
    })

    it('keeps ordinary links, marked safe for an external target', () => {
        const html = renderMarkdown('[hapi](https://example.com/a?b=1)')
        expect(html).toContain('href="https://example.com/a?b=1"')
        expect(html).toContain('rel="noopener noreferrer nofollow"')
    })

    it('keeps relative and anchor links', () => {
        expect(renderMarkdown('[a](/lite)')).toContain('href="/lite"')
        expect(renderMarkdown('[a](#x)')).toContain('href="#x"')
    })

    it('escapes quotes in an href so it cannot break out of the attribute', () => {
        const html = renderMarkdown('[x](https://e.com/")  onmouseover="alert(1))')
        expect(html).not.toContain('onmouseover="alert(1)"')
        expect(html).not.toMatch(/href="[^"]*"\s+on/)
    })

    it('renders images as links rather than fetching remote bytes', () => {
        const html = renderMarkdown('![alt](https://example.com/a.png)')
        expect(html).not.toContain('<img')
        expect(html).toContain('href="https://example.com/a.png"')
        expect(html).toContain('alt')
    })

    it('drops an image with an unsafe source entirely', () => {
        const html = renderMarkdown('![alt](javascript:alert(1))')
        expect(html).not.toContain('<a ')
        expect(html).not.toContain('javascript:')
    })

    it('escapes markup inside code spans and fences', () => {
        expect(renderMarkdown('`<script>x</script>`')).toContain('&lt;script&gt;')
        expect(renderMarkdown('```\n<script>x</script>\n```')).toContain('&lt;script&gt;')
    })

    it('escapes markup inside table cells and headings', () => {
        expect(renderMarkdown('| <script>a</script> |\n|---|\n| <b>c</b> |'))
            .not.toContain('<script>')
        expect(renderMarkdown('# <script>a</script>')).not.toContain('<script>')
    })

    it('escapes markup carried in a link label', () => {
        const html = renderMarkdown('[<script>a</script>](https://e.com)')
        expect(html).not.toContain('<script>')
    })

    it('never emits an event-handler attribute for any of these inputs', () => {
        const inputs = [
            '<div onclick="x">a</div>',
            '[a](https://e.com" onclick="x)',
            '<a href="#" onmouseover="x">b</a>',
            '![a](x" onerror="y)'
        ]
        for (const input of inputs) {
            // Only a handler inside a real tag matters; `onclick=` sitting in escaped
            // body text is inert, and asserting on the bare substring would be theatre.
            expect(renderMarkdown(input)).not.toMatch(/<[a-z]+[^>]*\son[a-z]+\s*=/i)
        }
    })
})

describe('renderPlainText', () => {
    it('escapes and preserves newlines without parsing markdown', () => {
        const html = renderPlainText('a <b>x</b>\n# not a heading')
        expect(html).toContain('&lt;b&gt;')
        expect(html).not.toContain('<h3>')
        expect(html).toContain('class="text"')
    })
})
