import { createContext } from 'react'

/**
 * Touch layouts scroll the chat with the page itself instead of an inner scroller, so mobile browsers can
 * collapse their toolbars on scroll (they only do that for the document). The workspace sets `doc-scroll` on
 * <html> while this is on; the chain of containers marked `doc-flow` then grows with its content.
 */
export const DocumentScrollContext = createContext(false)
