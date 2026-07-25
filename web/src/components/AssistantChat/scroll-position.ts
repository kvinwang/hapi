const ENTER_BOTTOM_THRESHOLD_PX = 16
const LEAVE_BOTTOM_THRESHOLD_PX = 64

export function isWithinChatBottomThreshold(distanceFromBottom: number, wasAtBottom: boolean): boolean {
    const threshold = wasAtBottom ? LEAVE_BOTTOM_THRESHOLD_PX : ENTER_BOTTOM_THRESHOLD_PX
    return distanceFromBottom <= threshold
}

export function findFirstVisibleMessage(
    children: HTMLCollection,
    viewportTop: number
): HTMLElement | null {
    let low = 0
    let high = children.length - 1
    let match: HTMLElement | null = null
    while (low <= high) {
        const middle = Math.floor((low + high) / 2)
        const child = children.item(middle)
        if (!(child instanceof HTMLElement)) {
            low = middle + 1
            continue
        }
        if (child.getBoundingClientRect().bottom >= viewportTop) {
            match = child
            high = middle - 1
        } else {
            low = middle + 1
        }
    }
    return match
}

/** Load-older should keep the live tail pinned when the user was already at bottom. */
export function shouldStayAtBottomOnLoadOlder(followBottom: boolean, atBottom: boolean): boolean {
    return followBottom || atBottom
}

/**
 * Top-sentinel auto-load is suppressed until the initial open pin settles or the
 * user intentionally scrolls upward. Manual "Load older" always bypasses this.
 */
export function shouldAllowAutoLoadOlder(args: {
    initialPinSettled: boolean
    userScrolledUp: boolean
}): boolean {
    return args.initialPinSettled || args.userScrolledUp
}


/** After prepend/layout, keep the pre-mutation viewport position. */
export function applyHeightDeltaScrollTop(
    scrollTop: number,
    previousScrollHeight: number,
    nextScrollHeight: number
): number {
    return scrollTop + (nextScrollHeight - previousScrollHeight)
}

export function applyAnchorOffsetScrollTop(
    scrollTop: number,
    previousOffset: number,
    nextOffset: number
): number {
    return scrollTop + (nextOffset - previousOffset)
}

export const LOAD_OLDER_SETTLE_MAX_MS = 450
export const LOAD_OLDER_SETTLE_STABLE_FRAMES = 3

export function shouldFinishScrollSettle(args: {
    stableHeightFrames: number
    elapsedMs: number
    maxMs?: number
    stableFrames?: number
}): boolean {
    const maxMs = args.maxMs ?? LOAD_OLDER_SETTLE_MAX_MS
    const stableFrames = args.stableFrames ?? LOAD_OLDER_SETTLE_STABLE_FRAMES
    return args.stableHeightFrames >= stableFrames || args.elapsedMs >= maxMs
}
