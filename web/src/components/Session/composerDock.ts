import { createContext } from 'react'

/**
 * Slot inside the floating workspace panel (touch layouts). When present, the chat composer hides
 * itself and portals its toggle/stop buttons into this slot, so the chat uses the full height.
 */
export const ComposerDockContext = createContext<HTMLElement | null>(null)
