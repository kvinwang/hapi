import { createContext } from 'react'

/**
 * Slot in the floating workspace panel, expanded or collapsed (touch layouts). When present, the chat composer hides
 * itself and portals its toggle/stop buttons into this slot, so the chat uses the full height.
 */
export const ComposerDockContext = createContext<HTMLElement | null>(null)
