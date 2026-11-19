/**
 * Remark plugin that ends auto-linked URLs at the first CJK/fullwidth
 * punctuation character.
 *
 * `remark-gfm` extends a bare URL until whitespace, so prose written
 * without spaces (e.g. `https://x/1（说明）`, `https://x，然后`) gets
 * swallowed into the link.  This plugin walks the MDAST after GFM runs and
 * moves everything from the first such character onwards out of the link
 * node into a sibling text node.  CJK ideographs are kept, as they can
 * legitimately appear in URL paths.
 */

// CJK Symbols and Punctuation, plus fullwidth ASCII punctuation (excluding fullwidth digits/letters).
const CJK_PUNCT = /[　-〿！-／：-＠［-｀｛-･]/

interface MdastNode {
    type: string
    url?: string
    value?: string
    children?: MdastNode[]
}

function visitLinks(node: MdastNode): void {
    if (!node.children) return

    for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i]

        // Only process auto-linked URLs (where the link text matches the URL).
        // Explicit markdown links like [text](url) should not be modified.
        const textChild = child.children?.[0]
        const isAutolink = child.type === 'link'
            && child.children?.length === 1
            && textChild?.type === 'text'
            && textChild.value === child.url

        if (isAutolink) {
            const cut = child.url!.search(CJK_PUNCT)
            if (cut > 0) {
                const rest = child.url!.slice(cut)
                child.url = textChild.value = child.url!.slice(0, cut)
                node.children.splice(++i, 0, { type: 'text', value: rest })
            }
            continue
        }

        visitLinks(child)
    }
}

export default function remarkStripCjkAutolink() {
    return (tree: MdastNode) => {
        visitLinks(tree)
    }
}
