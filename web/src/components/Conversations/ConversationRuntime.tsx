import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Outlet, useLocation, useMatchRoute, useNavigate, useSearch } from '@tanstack/react-router'
import type { ThreadInbox } from '@hapi/protocol/threads'
import { SessionChoiceDetails } from '@/components/SessionChoiceDetails'
import { VoiceEdgeGlow, VoiceOverlay, isVoiceEdgeGlowEnabled } from '@/components/VoiceOrb'
import { useSessions } from '@/hooks/queries/useSessions'
import { useConversationWorkspace } from '@/hooks/useConversationWorkspace'
import { useVoiceWorkspace } from '@/hooks/useVoiceWorkspace'
import { useAppContext } from '@/lib/app-context'
import { clearMessageWindow, ingestIncomingMessages, publishLiveMessage } from '@/lib/message-window-store'
import { createThreadVoiceApi, threadVoiceKey, threadVoiceMessage } from '@/lib/threadVoiceApi'
import { useTranslation } from '@/lib/use-translation'

type ConversationRuntimeValue = {
    layout: ReturnType<typeof useConversationWorkspace>
    assistant: ReturnType<typeof useVoiceWorkspace>
}

const ConversationRuntimeContext = createContext<ConversationRuntimeValue | null>(null)

export function useConversationRuntime(): ConversationRuntimeValue {
    const value = useContext(ConversationRuntimeContext)
    if (!value) throw new Error('useConversationRuntime must be used within ConversationRuntime')
    return value
}

/** Threads have no socket feed for voice, so poll while the assistant is listening or reading back. */
function useThreadVoiceFeed(threadId: string | undefined, live: boolean): void {
    const { api } = useAppContext()
    const history = useQuery({
        queryKey: ['threads', threadId, 'voice'],
        queryFn: () => api.threadRequest<ThreadInbox>(`/${threadId}/history?limit=100`),
        enabled: Boolean(threadId),
        refetchInterval: live ? 3_000 : false
    })
    const key = threadId ? threadVoiceKey(threadId) : null
    const seen = useRef<{ key: string | null; seq: number | null }>({ key, seq: null })
    useEffect(() => {
        if (seen.current.key !== key) seen.current = { key, seq: null }
        if (!key || !history.data) return
        const messages = history.data.messages.map(threadVoiceMessage)
        ingestIncomingMessages(key, messages)
        for (const message of messages) {
            if (seen.current.seq !== null && (message.seq ?? 0) > seen.current.seq) publishLiveMessage(key, message)
        }
        seen.current.seq = Math.max(seen.current.seq ?? 0, ...messages.map(message => message.seq ?? 0))
    }, [key, history.data])
    useEffect(() => (key ? () => clearMessageWindow(key) : undefined), [key])
}

/**
 * Everything that must outlive a switch between conversations, whatever their kind: the list/detail layout
 * and the voice assistant. Mounted above the session and thread routes, so the microphone stays on and is
 * only retargeted when the user moves between them.
 */
export function ConversationRuntime() {
    const { api, baseUrl, token } = useAppContext()
    const navigate = useNavigate()
    const client = useQueryClient()
    const pathname = useLocation({ select: location => location.pathname })
    const matchRoute = useMatchRoute()
    const search = useSearch({ strict: false })
    const { sessions } = useSessions(api)

    const threads = pathname === '/threads' || pathname.startsWith('/threads/')
    const threadMatch = matchRoute({ to: '/threads/$threadId', fuzzy: true })
    const sessionMatch = matchRoute({ to: '/sessions/$sessionId', fuzzy: true })
    const currentId = threads
        ? threadMatch ? threadMatch.threadId : null
        : sessionMatch && sessionMatch.sessionId !== 'new' ? sessionMatch.sessionId : null
    const layout = useConversationWorkspace({
        kind: threads ? 'threads' : 'sessions',
        currentId,
        isIndex: threads ? !currentId : pathname === '/sessions' || pathname === '/sessions/',
        baseUrl,
        fromSession: 'fromSession' in search ? search.fromSession : undefined
    })

    // The phone route passes through a bare list on its way to another conversation: stay on the last one.
    const lastTarget = useRef<{ threads: boolean; id: string } | null>(null)
    if (layout.selectedId) lastTarget.current = { threads, id: layout.selectedId }
    const target = lastTarget.current
    const threadId = target?.threads ? target.id : undefined

    const onThreadSent = useCallback(() => {
        void client.invalidateQueries({ queryKey: ['threads', threadId] })
    }, [client, threadId])
    const voiceApi = useMemo(
        () => (threadId ? createThreadVoiceApi(api, threadId, onThreadSent) : api),
        [api, threadId, onThreadSent]
    )
    const terminal = pathname.endsWith('/terminal')
    const assistant = useVoiceWorkspace({
        api: voiceApi,
        backgroundApi: api,
        baseUrl,
        token,
        sessionId: threadId ? threadVoiceKey(threadId) : target?.id ?? '',
        threadId,
        terminal,
        sessions,
        navigate: sessionId => {
            void navigate({ to: '/sessions/$sessionId', params: { sessionId } })
        }
    })
    useThreadVoiceFeed(threadId, assistant.voice.micOn || assistant.readback.enabled)

    return (
        <ConversationRuntimeContext.Provider value={{ layout, assistant }}>
            <Outlet />
            <VoiceSurfaces assistant={assistant} terminal={terminal} />
        </ConversationRuntimeContext.Provider>
    )
}

function VoiceSurfaces({ assistant, terminal }: { assistant: ConversationRuntimeValue['assistant']; terminal: boolean }) {
    const { guest } = useAppContext()
    const { t } = useTranslation()
    if (guest) return null
    const { voice, readback, choices, search } = assistant
    return (
        <>
            {readback.error ? (
                <div role="alert" className="fixed bottom-4 left-4 z-50 max-w-[90vw] rounded-lg bg-[var(--app-bg)] p-3 text-sm text-[var(--app-fg)] shadow-lg">
                    {t(readback.error)}
                </div>
            ) : null}
            {choices !== null ? (
                <div role="dialog" aria-label={t('voice.ui.sessions')} className="fixed inset-x-4 top-20 z-[60] mx-auto max-w-lg rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-4 shadow-xl">
                    <div className="mb-3 text-sm">{search ? t('voice.ui.matchingSessions', { query: search }) : t('voice.ui.sessions')}</div>
                    {choices.map((session, index) => (
                        <button
                            type="button"
                            key={session.id}
                            className="block w-full rounded p-2 text-left hover:bg-[var(--app-subtle-bg)]"
                            onClick={() => assistant.control({ action: 'select_session', index: index + 1 })}
                        >
                            <SessionChoiceDetails session={session} index={index + 1} />
                        </button>
                    ))}
                    {!choices.length ? <div>{t(search ? 'voice.ui.noMatchingSessions' : 'voice.ui.noSessions')}</div> : null}
                    <button type="button" className="mt-3 text-sm" onClick={() => assistant.control({ action: 'cancel_selection' })}>
                        {t('voice.ui.cancelSelection')}
                    </button>
                </div>
            ) : null}
            <VoiceOverlay
                panelVisibility={assistant.panel}
                onClosePanel={() => assistant.setPanel('closed')}
                answerStatus={assistant.answerStatus}
                caption={voice.caption}
                micRecovering={voice.micRecovering}
                readbackLanguage={readback.language}
                onReadbackLanguageChange={readback.setLanguage}
                readbackOutput={readback.output}
                onSelectReadbackOutput={readback.selectOutput}
                readbackActive={readback.playing}
                onInterruptReadback={readback.interrupt}
                target={terminal ? 'terminal' : 'chat'}
                draft={voice.draft}
                drafting={voice.drafting}
                deferred={voice.deferred}
                onResolveSpeech={voice.resolveSpeech}
                draftIssue={voice.draftIssue}
                transcription={voice.transcription}
                sending={voice.sending}
                autoSendSeconds={voice.autoSendSeconds}
                onSend={() => void voice.sendDraft()}
                onClear={voice.clearDraft}
                onResetHistory={() => assistant.control({ action: 'reset_voice' })}
                onKey={voice.pressKey}
            />
            {isVoiceEdgeGlowEnabled() ? <VoiceEdgeGlow state={voice.state} micOn={voice.micOn} level={voice.level} /> : null}
        </>
    )
}
