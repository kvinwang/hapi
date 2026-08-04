/**
 * Converts standard LaTeX delimiters to the dollar delimiters supported by
 * remark-math. Markdown code spans and fenced code blocks are left untouched.
 */
export function normalizeLatexDelimiters(markdown: string): string {
    let result = ''
    let index = 0
    let lineStart = true
    let fence: { marker: '`' | '~'; length: number } | null = null
    let inlineCodeLength = 0

    while (index < markdown.length) {
        if (lineStart && inlineCodeLength === 0) {
            const fenceMatch = markdown.slice(index).match(/^( {0,3})(`{3,}|~{3,})/)
            if (fenceMatch) {
                const markerRun = fenceMatch[2]
                const marker = markerRun[0] as '`' | '~'
                const isClosing = isClosingFence(fence, marker, markerRun.length)

                if (!fence) fence = { marker, length: markerRun.length }
                else if (isClosing) fence = null

                result += fenceMatch[0]
                index += fenceMatch[0].length
                lineStart = false
                continue
            }
        }

        const character = markdown[index]

        if (!fence && character === '`') {
            let runLength = 1
            while (markdown[index + runLength] === '`') runLength++

            if (inlineCodeLength === 0) {
                inlineCodeLength = runLength
            } else if (runLength === inlineCodeLength) {
                inlineCodeLength = 0
            }

            result += markdown.slice(index, index + runLength)
            index += runLength
            lineStart = false
            continue
        }

        if (!fence && inlineCodeLength === 0 && character === '\\' && markdown[index - 1] !== '\\') {
            const delimiter = markdown[index + 1]
            if (delimiter === '[' || delimiter === ']') {
                result += '$$'
                index += 2
                lineStart = false
                continue
            }
            if (delimiter === '(' || delimiter === ')') {
                result += '$'
                index += 2
                lineStart = false
                continue
            }
        }

        result += character
        index++
        lineStart = character === '\n'
    }

    return result
}

function isClosingFence(
    fence: { marker: '`' | '~'; length: number } | null,
    marker: '`' | '~',
    length: number,
): boolean {
    return fence !== null && fence.marker === marker && length >= fence.length
}
