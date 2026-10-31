const BRACKET_LINE = /^\[[^\n]*\]$/

/**
 * Relayed messages (e.g. from the car assistant) open with machine context such as
 * `[电脑#20 2026-10-31 10:24 Sat；…]`, sometimes followed by background lines up to a closing
 * marker like `[用户对你说]`. That preamble runs from a first `[…]` line through the last `[…]`
 * line; the rest is the actual request. Returns null when there is no such preamble or no body.
 */
export function splitContextPreamble(text: string): { label: string; preamble: string; body: string } | null {
    const lines = text.split('\n')
    if (!BRACKET_LINE.test(lines[0]?.trim() ?? '')) return null
    let last = 0
    lines.forEach((line, index) => {
        if (BRACKET_LINE.test(line.trim())) last = index
    })
    const body = lines.slice(last + 1).join('\n').trim()
    if (!body) return null
    return {
        label: lines[0].trim().slice(1, -1),
        preamble: lines.slice(0, last + 1).join('\n'),
        body
    }
}
