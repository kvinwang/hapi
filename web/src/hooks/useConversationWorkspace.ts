import { useCallback, useEffect, useState } from 'react'
import { useWorkspaceLayout } from './useWorkspaceLayout'
import { useResizableWidth } from './useResizableWidth'
import { useConversationHistory, type ConversationKind } from './useConversationHistory'

export function useConversationWorkspace({
    kind,
    currentId,
    isIndex,
    baseUrl,
    fromSession
}: {
    kind: ConversationKind
    currentId?: string | null
    isIndex: boolean
    baseUrl?: string
    fromSession?: string
}) {
    const { history, remember } = useConversationHistory(baseUrl)
    const persistent = useWorkspaceLayout().sessionSidebar === 'persistent'
    const resize = useResizableWidth({
        storageKey: 'hapi-sidebar-width',
        min: 280,
        max: 600,
        defaultWidth: 340,
        edge: 'right'
    })
    const [drawer, setDrawer] = useState(false)
    const [sidebar, setSidebar] = useState(() => {
        try {
            return localStorage.getItem('hapi-sidebar-visible') !== '0'
        } catch {
            return true
        }
    })
    useEffect(() => {
        if (currentId) remember(kind, currentId, fromSession)
    }, [kind, currentId, fromSession, remember])
    useEffect(() => {
        setDrawer(false)
    }, [currentId, isIndex])
    useEffect(() => {
        try {
            localStorage.setItem('hapi-sidebar-visible', sidebar ? '1' : '0')
        } catch {
            /* Storage is optional. */
        }
    }, [sidebar])
    useEffect(() => {
        if (!drawer) return
        const escape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setDrawer(false)
        }
        window.addEventListener('keydown', escape)
        return () => window.removeEventListener('keydown', escape)
    }, [drawer])
    const closeDrawer = useCallback(() => setDrawer(false), [])
    const hideSidebar = useCallback(() => setSidebar(false), [])
    const toggleSidebar = useCallback(() => {
        if (persistent) setSidebar(value => !value)
        else setDrawer(value => !value)
    }, [persistent])
    return {
        ...resize,
        persistent,
        isIndex,
        selectedId: currentId ?? (isIndex && persistent ? history[kind]?.id : undefined),
        fromSession: currentId ? fromSession : history[kind]?.fromSession,
        drawer: !isIndex && !persistent && drawer,
        showList: isIndex || (persistent ? sidebar : drawer),
        showContent: persistent || !isIndex,
        sidebarVisible: persistent ? sidebar : drawer,
        closeDrawer,
        hideSidebar,
        toggleSidebar
    }
}
