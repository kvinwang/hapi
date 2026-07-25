const ENTER_BOTTOM_THRESHOLD_PX = 16
const LEAVE_BOTTOM_THRESHOLD_PX = 64

export function isWithinChatBottomThreshold(distanceFromBottom: number, wasAtBottom: boolean): boolean {
    const threshold = wasAtBottom ? LEAVE_BOTTOM_THRESHOLD_PX : ENTER_BOTTOM_THRESHOLD_PX
    return distanceFromBottom <= threshold
}
