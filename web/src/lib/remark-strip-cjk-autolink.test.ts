import { describe, expect, it } from 'vitest'
import remarkStripCjkAutolink from '@/lib/remark-strip-cjk-autolink'

/**
 * Unit tests for the remark-strip-cjk-autolink plugin.
 *
 * We test the tree-transform function directly by feeding it MDAST
 * structures that remark-gfm would produce for auto-linked URLs.
 */
describe('remarkStripCjkAutolink', () => {
    const transform = remarkStripCjkAutolink()

    function makeAutolink(url: string) {
        return {
            type: 'root',
            children: [
                {
                    type: 'paragraph',
                    children: [
                        { type: 'text', value: 'See ' },
                        {
                            type: 'link',
                            url,
                            children: [{ type: 'text', value: url }]
                        }
                    ]
                }
            ]
        }
    }

    it('strips trailing fullwidth comma from URL', () => {
        const tree = makeAutolink('https://example.com/path，')
        transform(tree)

        const paragraph = tree.children[0]
        const link = paragraph.children[1]
        expect(link.url).toBe('https://example.com/path')
        expect(link.children![0].value).toBe('https://example.com/path')

        // Punctuation moved to a new text node after the link
        const punct = paragraph.children[2]
        expect(punct.type).toBe('text')
        expect(punct.value).toBe('，')
    })

    it('strips trailing ideographic full stop', () => {
        const tree = makeAutolink('https://example.com。')
        transform(tree)

        const paragraph = tree.children[0]
        const link = paragraph.children[1]
        expect(link.url).toBe('https://example.com')
        expect(paragraph.children[2].value).toBe('。')
    })

    it('strips multiple trailing CJK punctuation characters', () => {
        const tree = makeAutolink('https://example.com，。')
        transform(tree)

        const paragraph = tree.children[0]
        const link = paragraph.children[1]
        expect(link.url).toBe('https://example.com')
        expect(paragraph.children[2].value).toBe('，。')
    })

    it('does not modify URLs without CJK trailing punctuation', () => {
        const tree = makeAutolink('https://example.com/path')
        transform(tree)

        const link = tree.children[0].children[1]
        expect(link.url).toBe('https://example.com/path')
        // No extra node inserted
        expect(tree.children[0].children.length).toBe(2)
    })

    it('ends the URL at a fullwidth paren followed by prose', () => {
        const tree = makeAutolink('https://github.com/o/r/pull/1626（目标分支')
        transform(tree)

        const paragraph = tree.children[0]
        const link = paragraph.children[1]
        expect(link.url).toBe('https://github.com/o/r/pull/1626')
        expect(link.children![0].value).toBe('https://github.com/o/r/pull/1626')
        expect(paragraph.children[2].value).toBe('（目标分支')
    })

    it('ends the URL at mid-text CJK punctuation', () => {
        const tree = makeAutolink('https://example.com/path，然后')
        transform(tree)

        const paragraph = tree.children[0]
        expect(paragraph.children[1].url).toBe('https://example.com/path')
        expect(paragraph.children[2].value).toBe('，然后')
    })

    it('strips sentence-ending punctuation followed by closing bracket', () => {
        const tree = makeAutolink('https://example.com/path。）')
        transform(tree)

        const paragraph = tree.children[0]
        const link = paragraph.children[1]
        expect(link.url).toBe('https://example.com/path')
        expect(paragraph.children[2].value).toBe('。）')
    })

    it('ends the URL at the first non-ASCII character', () => {
        const tree = makeAutolink('https://example.com/见文档')
        transform(tree)

        const paragraph = tree.children[0]
        expect(paragraph.children[1].url).toBe('https://example.com/')
        expect(paragraph.children[2].value).toBe('见文档')
    })

    it('does not modify explicit markdown links', () => {
        // Explicit markdown link: [click here](https://example.com/path）)
        // The link text differs from the URL, so it's not an autolink
        const tree = {
            type: 'root',
            children: [
                {
                    type: 'paragraph',
                    children: [
                        {
                            type: 'link',
                            url: 'https://example.com/path）',
                            children: [{ type: 'text', value: 'click here' }]
                        }
                    ]
                }
            ]
        }
        transform(tree)

        const link = tree.children[0].children[0]
        expect(link.url).toBe('https://example.com/path）')
        expect(tree.children[0].children.length).toBe(1)
    })
})
