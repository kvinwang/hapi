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
