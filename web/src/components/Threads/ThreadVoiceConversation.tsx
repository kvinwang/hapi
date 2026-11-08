import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { ThreadInbox } from '@hapi/protocol/threads'
import { useAppContext } from '@/lib/app-context'
import { createThreadVoiceApi, threadVoiceKey, threadVoiceMessage } from '@/lib/threadVoiceApi'
import { clearMessageWindow, ingestIncomingMessages, publishLiveMessage } from '@/lib/message-window-store'
import { useVoiceWorkspace } from '@/hooks/useVoiceWorkspace'
import { useSessions } from '@/hooks/queries/useSessions'
import { useTranslation } from '@/lib/use-translation'
import { WorkspaceTools } from '@/components/Session/WorkspaceTools'
import { SessionChoiceDetails } from '@/components/SessionChoiceDetails'
import { VoiceEdgeGlow, VoiceOrb, VoiceOverlay, isVoiceEdgeGlowEnabled } from '@/components/VoiceOrb'
import { ThreadChat } from './ThreadChat'

export function ThreadVoiceConversation({
    threadId,
    fromSession,
    toggleSidebar,
    sidebarVisible
}: {
    threadId: string
    fromSession?: string
    toggleSidebar: () => void
    sidebarVisible: boolean
}) {
    const { api, baseUrl, token } = useAppContext()
    const { t } = useTranslation()
    const navigate = useNavigate()
    const client = useQueryClient()
    const { sessions } = useSessions(api)
    const onSent = useCallback(() => {
        void client.invalidateQueries({ queryKey: ['threads', threadId] })
    }, [client, threadId])
    const voiceApi = useMemo(() => createThreadVoiceApi(api, threadId, onSent), [api, threadId, onSent])
    const key = threadVoiceKey(threadId)
    const assistant = useVoiceWorkspace({
        api: voiceApi,
        backgroundApi: api,
        baseUrl,
        token,
        sessionId: key,
        threadId,
        terminal: false,
        sessions,
        navigate: id => {
            void navigate({ to: '/sessions/$sessionId', params: { sessionId: id } })
        }
    })
    const { voice, readback } = assistant
    const history = useQuery({
        queryKey: ['threads', threadId, 'voice'],
        queryFn: () => api.threadRequest<ThreadInbox>(`/${threadId}/history?limit=100`),
        refetchInterval: voice.micOn || readback.enabled ? 3_000 : false
    })
    const seen = useRef<{ key: string; seq: number | null }>({ key, seq: null })
    useEffect(() => {
        if (seen.current.key !== key) seen.current = { key, seq: null }
        if (!history.data) return
        const messages = history.data.messages.map(threadVoiceMessage)
        ingestIncomingMessages(key, messages)
        for (const message of messages) {
            if (seen.current.seq !== null && (message.seq ?? 0) > seen.current.seq) publishLiveMessage(key, message)
        }
        seen.current.seq = Math.max(seen.current.seq ?? 0, ...messages.map(message => message.seq ?? 0))
    }, [key, history.data])
    useEffect(() => () => clearMessageWindow(key), [key])
    const button =
        'flex h-9 w-9 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]'
    return (
        <>
            <WorkspaceTools
                items={{
                    voice: (
                        <VoiceOrb
                            state={voice.state}
                            micOn={voice.micOn}
                            level={voice.level}
                            size={34}
                            onClick={voice.toggle}
                        />
                    ),
                    readback: (
                        <button
                            type="button"
                            className={button}
                            aria-label={t('readback.toggle')}
                            title={t(readback.enabled ? 'readback.on' : 'readback.off')}
                            aria-pressed={readback.enabled}
                            onClick={readback.toggle}
                        >
                            <svg
                                aria-hidden="true"
                                width="18"
                                height="18"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                            >
                                <path d="m11 5-6 4H2v6h3l6 4z" />
                                {readback.enabled ? (
                                    <path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" />
                                ) : (
                                    <path d="m16 9 5 6m0-6-5 6" />
                                )}
                            </svg>
                        </button>
                    ),
                    sessions: (
                        <button
                            type="button"
                            className={button}
                            aria-label="Thread list"
                            title="Thread list"
                            aria-pressed={sidebarVisible}
                            onClick={toggleSidebar}
                        >
                            <svg
                                aria-hidden="true"
                                width="18"
                                height="18"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                            >
                                <rect x="3" y="3" width="18" height="18" rx="2" />
                                <path d="M9 3v18M13 8h4M13 12h4" />
                            </svg>
                        </button>
                    ),
                    refresh: (
                        <button
                            type="button"
                            className={button}
                            aria-label={t('toolbar.refreshPage')}
                            title={t('toolbar.refreshPage')}
                            onClick={() => window.location.reload()}
                        >
                            <svg
                                aria-hidden="true"
                                width="18"
                                height="18"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                            >
                                <path d="M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 17.9 17" />
                            </svg>
                        </button>
                    )
                }}
            >
                <div className="min-h-0 min-w-0 flex-1">
                    <ThreadChat key={threadId} threadId={threadId} fromSession={fromSession} />
                </div>
            </WorkspaceTools>
            {readback.error && (
                <div
                    role="alert"
                    className="fixed bottom-4 left-4 z-50 rounded-lg bg-[var(--app-bg)] p-3 text-sm shadow-lg"
                >
                    {t(readback.error)}
                </div>
            )}
            {assistant.choices !== null && (
                <div
                    role="dialog"
                    aria-label={t('voice.ui.sessions')}
                    className="fixed inset-x-4 top-20 z-[60] mx-auto max-w-lg rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-4 shadow-xl"
                >
                    <div className="mb-3 text-sm">{t('voice.ui.sessions')}</div>
                    {assistant.choices.map((session, index) => (
                        <button
                            type="button"
                            key={session.id}
                            className="block w-full rounded p-2 text-left hover:bg-[var(--app-subtle-bg)]"
                            onClick={() => assistant.control({ action: 'select_session', index: index + 1 })}
                        >
                            <SessionChoiceDetails session={session} index={index + 1} />
                        </button>
                    ))}
                    {!assistant.choices.length && <p>{t('voice.ui.noSessions')}</p>}
                    <button
                        type="button"
                        className="mt-3 text-sm"
                        onClick={() => assistant.control({ action: 'cancel_selection' })}
                    >
                        {t('voice.ui.cancelSelection')}
                    </button>
                </div>
            )}
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
                target="chat"
                draft={voice.draft}
                getDebugContext={voice.getDebugContext}
                onDraftChange={voice.editDraft}
                onDraftEditStart={voice.beginDraftEdit}
                onDraftEditEnd={voice.endDraftEdit}
                micOn={voice.micOn}
                onToggleMic={voice.toggle}
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
            {isVoiceEdgeGlowEnabled() && <VoiceEdgeGlow state={voice.state} micOn={voice.micOn} level={voice.level} />}
        </>
    )
}
