import { useState, type ReactNode } from 'react'
import { ComposerDockContext } from '@/components/Session/composerDock'
import { DocumentScrollContext } from '@/components/Session/documentScroll'
import type { PanelItemId } from '@/components/Session/PanelSections'
import { listButton, type WorkspaceButtonId } from '@/components/Session/WorkspaceTabBar'
import { WorkspaceTools } from '@/components/Session/WorkspaceTools'
import { VoiceOrb } from '@/components/VoiceOrb'
import { useWorkspaceLayout } from '@/hooks/useWorkspaceLayout'
import { useTranslation } from '@/lib/use-translation'
import { useConversationRuntime } from './ConversationRuntime'

/** What a conversation offers. The frame turns this into toolbar items and page behaviour. */
export type ConversationCapabilities = {
    voice: boolean
    readback: boolean
    /** Has a composer that can dock into the toolbar. */
    composer: boolean
    /** Scrolls with the page on touch layouts, so mobile browsers can collapse their toolbars. */
    documentScroll: boolean
    list: { title: string; label: string; active: boolean; onToggle: () => void }
    /** Items only this kind of conversation has, such as the session's tabs. */
    items?: Partial<Record<Exclude<WorkspaceButtonId, 'sessions'>, ReactNode>>
}

export function ConversationFrame({ capabilities, children }: { capabilities: ConversationCapabilities; children: ReactNode }) {
    const { assistant } = useConversationRuntime()
    const { t } = useTranslation()
    const { composer: composerLayout } = useWorkspaceLayout()
    const [composerDock, setComposerDock] = useState<HTMLElement | null>(null)
    const { voice, readback } = assistant
    const items: Partial<Record<PanelItemId, ReactNode>> = {
        voice: capabilities.voice
            ? <VoiceOrb state={voice.state} micOn={voice.micOn} level={voice.level} size={34} onClick={voice.toggle} />
            : undefined,
        readback: capabilities.readback ? (
            <button
                type="button"
                onClick={readback.toggle}
                aria-pressed={readback.enabled}
                aria-label={t('readback.toggle')}
                title={readback.error ? t(readback.error) : t(readback.enabled ? 'readback.on' : 'readback.off')}
                className={`flex h-9 w-9 items-center justify-center rounded-md ${readback.enabled ? 'bg-[var(--app-subtle-bg)] text-[var(--app-link)]' : 'text-[var(--app-hint)]'}`}
            >
                <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="m11 5-6 4H2v6h3l6 4z" />
                    {readback.enabled ? <path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" /> : <path d="m16 9 5 6m0-6-5 6" />}
                </svg>
            </button>
        ) : undefined,
        // In a hidden (collapsed) section the composer stays docked without showing its buttons.
        composer: capabilities.composer ? <div ref={setComposerDock} className="flex flex-col items-center gap-2" /> : undefined,
        sessions: listButton(capabilities.list),
        ...capabilities.items
    }
    return (
        <WorkspaceTools items={items}>
            <ComposerDockContext.Provider value={capabilities.composer ? composerDock : null}>
                <DocumentScrollContext.Provider value={capabilities.documentScroll && composerLayout === 'docked'}>
                    {children}
                </DocumentScrollContext.Provider>
            </ComposerDockContext.Provider>
        </WorkspaceTools>
    )
}
