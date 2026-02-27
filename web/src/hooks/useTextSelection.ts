import { useCallback, useEffect, useState, type RefObject } from 'react'

export type SelectionInfo = {
    startLine: number
    endLine: number
    rect: DOMRect
}

function findLineAncestor(node: Node | null): number | null {
    let current = node
    while (current && current instanceof HTMLElement) {
        const line = current.getAttribute('data-line')
        if (line) return parseInt(line, 10)
        current = current.parentElement
    }
    // Also check if the node is a text node inside a line element
    if (node && node.nodeType === Node.TEXT_NODE && node.parentElement) {
        return findLineAncestor(node.parentElement)
    }
    return null
}

export function useTextSelection(containerRef: RefObject<HTMLElement | null>): {
    selection: SelectionInfo | null
    clearSelection: () => void
} {
    const [selection, setSelection] = useState<SelectionInfo | null>(null)

    const clearSelection = useCallback(() => {
        window.getSelection()?.removeAllRanges()
        setSelection(null)
    }, [])

    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null

        function handleSelectionChange() {
            if (timer) clearTimeout(timer)
            timer = setTimeout(() => {
                const sel = window.getSelection()
                if (!sel || sel.isCollapsed || !sel.rangeCount) {
                    setSelection(null)
                    return
                }

                const container = containerRef.current
                if (!container) { setSelection(null); return }

                const range = sel.getRangeAt(0)
                if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) {
                    setSelection(null)
                    return
                }

                const startLine = findLineAncestor(range.startContainer)
                const endLine = findLineAncestor(range.endContainer)
                if (startLine == null || endLine == null) {
                    setSelection(null)
                    return
                }

                const rect = range.getBoundingClientRect()
                setSelection({
                    startLine: Math.min(startLine, endLine),
                    endLine: Math.max(startLine, endLine),
                    rect,
                })
            }, 100)
        }

        document.addEventListener('selectionchange', handleSelectionChange)
        return () => {
            document.removeEventListener('selectionchange', handleSelectionChange)
            if (timer) clearTimeout(timer)
        }
    }, [containerRef])

    return { selection, clearSelection }
}
