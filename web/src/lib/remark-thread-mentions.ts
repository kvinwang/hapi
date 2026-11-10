import { THREAD_MENTION } from '@hapi/protocol/threads'

interface MdastNode {
    type: string
    value?: string
    children?: MdastNode[]
    data?: Record<string, unknown>
}

function split(value: string, names: Map<string, string>): MdastNode[] {
    const nodes: MdastNode[] = []
    let last = 0
    for (const match of value.matchAll(THREAD_MENTION)) {
        const name = names.get(match[1])
        if (name === undefined) continue
        if (match.index > last) nodes.push({ type: 'text', value: value.slice(last, match.index) })
        nodes.push({ type: 'text', value: `@${name}`, data: { hName: 'span', hProperties: { className: 'font-medium text-[var(--app-link)]', title: match[1] } } })
        last = match.index + match[0].length
    }
    if (last < value.length) nodes.push({ type: 'text', value: value.slice(last) })
    return nodes
}

function visit(node: MdastNode, names: Map<string, string>): void {
    if (!node.children) return
    node.children = node.children.flatMap(child => {
        if (child.type === 'text' && child.value) return split(child.value, names)
        visit(child, names)
        return [child]
    })
}

/** Remark plugin that shows `@<member id>` mentions as highlighted `@name`, leaving code untouched. */
export default function remarkThreadMentions(names: Map<string, string>) {
    return (tree: MdastNode) => visit(tree, names)
}
