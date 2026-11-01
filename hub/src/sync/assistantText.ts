/** Extract text from an assistant (agent) message content envelope */
export function extractAssistantText(content: unknown): string | null {
    if (!content || typeof content !== 'object') return null
    const record = content as Record<string, unknown>

    if (record.role !== 'agent') return null

    const inner = record.content
    if (typeof inner === 'string') return inner

    // HAPI output format: {type: "output", data: {type: "assistant", message: {content: [...]}}}
    if (typeof inner === 'object' && inner !== null) {
        const innerRec = inner as Record<string, unknown>
        if (innerRec.type === 'codex' && innerRec.data && typeof innerRec.data === 'object') {
            const data = innerRec.data as Record<string, unknown>
            return data.type === 'message' && typeof data.message === 'string' ? data.message.trim() || null : null
        }
        if (innerRec.type === 'output' && typeof innerRec.data === 'object' && innerRec.data !== null) {
            const data = innerRec.data as Record<string, unknown>
            if (data.type === 'assistant' && typeof data.message === 'object' && data.message !== null) {
                const msg = data.message as Record<string, unknown>
                if (Array.isArray(msg.content)) {
                    return extractTextBlocks(msg.content)
                }
            }
        }
        if (typeof innerRec.text === 'string') return innerRec.text
    }

    if (Array.isArray(inner)) {
        return extractTextBlocks(inner)
    }

    return null
}

function extractTextBlocks(blocks: unknown[]): string | null {
    const parts: string[] = []
    for (const block of blocks) {
        if (block && typeof block === 'object' && typeof (block as Record<string, unknown>).type === 'string') {
            const b = block as Record<string, unknown>
            if ((b.type === 'text' || b.type === 'input_text') && typeof b.text === 'string') {
                parts.push(b.text)
            }
        }
    }
    return parts.length > 0 ? parts.join('\n').trim() : null
}
