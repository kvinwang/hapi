/**
 * Where the jump-to-latest button sits.
 *
 * Stored as a fraction of the chat area rather than pixels: the same session is
 * read on a phone in portrait, the same phone sideways, and a desktop pane, and
 * a remembered pixel offset would land off-screen in two of the three. The
 * fractions are clamped on the way out, so a stale value can never hide the
 * button.
 */

export type JumpButtonPosition = {
    /** Centre of the button, as a fraction of the chat area. */
    xRatio: number
    yRatio: number
}

export type Box = { width: number; height: number }

const STORAGE_KEY = 'hapi-jump-latest-position'
/** Keeps the button clear of the composer and the viewport edges. */
export const JUMP_BUTTON_MARGIN = 12

export function clampRatio(value: number): number {
    if (!Number.isFinite(value)) return 0.5
    return Math.min(1, Math.max(0, value))
}

/**
 * Top-left corner for a stored position, kept fully inside the chat area.
 * Returns null when the area is too small to hold the button at all — the
 * button then goes home to its default corner instead of hanging off an edge.
 */
export function positionToOffset(
    position: JumpButtonPosition,
    container: Box,
    button: Box,
    margin = JUMP_BUTTON_MARGIN
): { left: number; top: number } | null {
    const maxLeft = container.width - button.width - margin
    const maxTop = container.height - button.height - margin
    if (maxLeft < margin || maxTop < margin) return null
    const left = clampRatio(position.xRatio) * container.width - button.width / 2
    const top = clampRatio(position.yRatio) * container.height - button.height / 2
    return {
        left: Math.min(Math.max(left, margin), maxLeft),
        top: Math.min(Math.max(top, margin), maxTop)
    }
}

/** Fractions for a dragged corner, so the next viewport can place it again. */
export function offsetToPosition(
    offset: { left: number; top: number },
    container: Box,
    button: Box
): JumpButtonPosition {
    if (container.width <= 0 || container.height <= 0) return { xRatio: 0.5, yRatio: 0.9 }
    return {
        xRatio: clampRatio((offset.left + button.width / 2) / container.width),
        yRatio: clampRatio((offset.top + button.height / 2) / container.height)
    }
}

export function loadJumpButtonPosition(): JumpButtonPosition | null {
    if (typeof window === 'undefined') return null
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw) as Partial<JumpButtonPosition>
        if (typeof parsed?.xRatio !== 'number' || typeof parsed?.yRatio !== 'number') return null
        return { xRatio: clampRatio(parsed.xRatio), yRatio: clampRatio(parsed.yRatio) }
    } catch {
        return null
    }
}

export function clearJumpButtonPosition(): void {
    if (typeof window === 'undefined') return
    try {
        window.localStorage.removeItem(STORAGE_KEY)
    } catch {
        // Nothing to clear.
    }
}

export function saveJumpButtonPosition(position: JumpButtonPosition): void {
    if (typeof window === 'undefined') return
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(position))
    } catch {
        // Storage is optional; the drag still applies to this session.
    }
}

/** Movement under this is a tap, not a drag. */
export const DRAG_THRESHOLD_PX = 4
