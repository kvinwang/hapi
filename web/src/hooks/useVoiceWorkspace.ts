import { makeClientSideId } from '@/lib/messages'
import { appendOptimisticMessage, updateMessageStatus } from '@/lib/message-window-store'
import { optimisticUserMessage } from '@/hooks/mutations/useSendMessage'
import { useVoiceAutoSendSettings } from './useVoiceAutoSend'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { VoiceApi } from '@/lib/voiceApi'
import type { SessionSummary } from '@/types/api'
import type { VoiceUiControl } from '@/lib/voiceUiControl'
import { useAiReadback } from './useAiReadback'
import { useOmniVoice } from './useOmniVoice'

export function useVoiceWorkspace(options: { api: VoiceApi; baseUrl: string; token: string; sessionId: string; threadId?: string; terminal: boolean; sessions: SessionSummary[]; navigate: (id: string) => void }) {
    const [writer, setWriter] = useState<((text: string) => boolean) | null>(null)
    const registerWriter = useCallback((next: ((text: string) => boolean) | null) => setWriter(() => next), [])
    const [panel, setPanel] = useState<'auto' | 'closed'>('auto')
    const [choices, setChoices] = useState<SessionSummary[] | null>(null)
    const [answerStatus, setAnswerStatus] = useState<'answering' | 'forwarded' | null>(null)
    useEffect(() => {
        if (!answerStatus) return
        const timer = setTimeout(() => setAnswerStatus(null), 12000)
        return () => clearTimeout(timer)
    }, [answerStatus])
    const currentSession = useRef(options.sessionId)
    currentSession.current = options.sessionId
    const [search, setSearch] = useState('')
    const choicesRef = useRef(choices)
    choicesRef.current = choices
    useEffect(() => { choicesRef.current = null; setChoices(null); setAnswerStatus(null) }, [options.sessionId])
    const autoSend = useVoiceAutoSendSettings()
    const readback = useAiReadback(options)
    const control = (command: VoiceUiControl) => {
        switch (command.action) {
            case 'list_sessions': {
                setSearch('')
                const recent = options.sessions.filter(s => s.active && s.id !== options.sessionId)
                    .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5)
                choicesRef.current = recent
                setChoices(recent)
                return { choices: recent.map((s, i) => ({ index: i + 1, directory: s.metadata?.path, child: Boolean(s.parentSessionId || s.metadata?.subagent), title: s.metadata?.name || s.metadata?.summary?.text || s.metadata?.path || s.id })) }
            }
            case 'switch_session': {
                const selected = options.sessions.find(session => session.active && session.id === command.sessionId)
                if (!selected) return { error: 'The selected session is not active or not in the current catalog.' }
                choicesRef.current = null
                setChoices(null)
                options.navigate(selected.id)
                return { selected: selected.id }
            }
            case 'suggest_sessions': {
                const candidates = [...new Set(command.sessionIds)].flatMap(id => {
                    const session = options.sessions.find(s => s.active && s.id === id)
                    return session ? [session] : []
                })
                choicesRef.current = candidates
                setSearch(command.query)
                setChoices(candidates)
                return { choices: candidates.map((session, index) => ({ index: index + 1, sessionId: session.id })) }
            }
            case 'select_session': {
                const selected = choicesRef.current?.[command.index - 1]
                if (!selected || !options.sessions.some(s => s.id === selected.id && s.active)) return { error: 'No such entry in the displayed list. Call list_sessions first.' }
                choicesRef.current = null
                setChoices(null)
                options.navigate(selected.id)
                return { selected: command.index }
            }
            case 'cancel_selection': choicesRef.current = null; setChoices(null); break
            case 'auto_send': autoSend.update({ enabled: command.enabled ?? autoSend.enabled, delay: command.delay ?? autoSend.delay }); break
            case 'answer_readback': {
                const sessionId = options.sessionId
                const localId = makeClientSideId('voice-question')
                setAnswerStatus('answering')
                void readback.replayLatest(undefined, command.question, async () => {
                    if (currentSession.current !== sessionId) return
                    const target = await options.api.resumeSession(sessionId)
                    if (currentSession.current !== sessionId) return
                    appendOptimisticMessage(target, optimisticUserMessage({ text: command.question, localId, createdAt: Date.now() }))
                    try {
                        await options.api.sendMessage(target, command.question, localId)
                        updateMessageStatus(target, localId, 'sent')
                        if (currentSession.current === sessionId) setAnswerStatus('forwarded')
                    } catch (error) { updateMessageStatus(target, localId, 'failed'); throw error }
                })
                break
            }
            case 'replay_readback': void readback.replayLatest(command.focus); break
            case 'stop_readback': readback.interrupt(); break
            case 'readback': readback.setEnabled(command.enabled); break
            case 'draft_panel': setPanel(command.open ? 'auto' : 'closed'); break
            case 'reset_voice': choicesRef.current = null; setChoices(null); setPanel('auto'); voice.resetHistory(); break
        }
        return { ok: true }
    }
    const voice = useOmniVoice({ ...options, target: options.terminal ? 'terminal' : 'chat', writeTerminal: writer ?? undefined,
        onSpeechStart: () => setPanel('auto'), onUiControl: control, selectingSession: choices !== null, autoSendBlocked: panel === 'closed' || choices !== null,
        uiContext: JSON.stringify({ currentSessionId: options.threadId ? null : options.sessionId, currentThreadId: options.threadId,
            availableSessions: options.sessions.filter(s => s.active).map(s => ({ id: s.id, title: s.metadata?.name || s.metadata?.summary?.text || s.metadata?.path || s.id,
                summary: s.metadata?.summary?.text ?? '', recentActivity: s.activity?.text ?? '', activitySource: s.activity?.source,
                directory: s.metadata?.path ?? '', parentSessionId: s.parentSessionId ?? null, updatedAt: s.updatedAt })),
            autoSend: { enabled: autoSend.enabled, delay: autoSend.delay }, readback: readback.enabled, draftPanel: panel, sessionChoices: choices?.map((s, i) => ({ index: i + 1, directory: s.metadata?.path, child: Boolean(s.parentSessionId || s.metadata?.subagent), title: s.metadata?.name || s.metadata?.summary?.text || s.id })) ?? null }) })
    return { voice: { ...voice, clearDraft: () => { setPanel('auto'); voice.clearDraft() } }, readback, panel, setPanel, choices, search, answerStatus, control, registerWriter }
}
