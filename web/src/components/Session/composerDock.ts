import { createContext } from 'react'

/**
 * Slot in the desktop or floating workspace panel for composer toggle/stop buttons.
 * The composer stays mounted while hidden, preserving its draft.
 */
export const ComposerDockContext = createContext<HTMLElement | null>(null)
