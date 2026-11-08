import { getVoiceSensitivity, setVoiceSensitivity } from '@/lib/voiceSensitivity'
import { OPEN_VOICE_PANEL, useVoicePanelSettings } from './useVoicePanelSettings'
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

export function useVoiceWorkspace(options: { api: VoiceApi; baseUrl: string; token: string; sessionId: string; threadId?: string; backgroundApi?: VoiceApi; terminal: boolean; sessions: SessionSummary[]; navigate: (id: string) => void }) {
    const [writer, setWriter] = useState<((text: string) => boolean) | null>(null)
    const registerWriter = useCallback((next: ((text: string) => boolean) | null) => setWriter(() => next), [])
    const panelSettings = useVoicePanelSettings()
    const { mode: panelMode } = panelSettings
    const [panel, setPanel] = useState<'auto' | 'open' | 'closed'>('auto')
    useEffect(() => {
        const open = () => setPanel('open')
        window.addEventListener(OPEN_VOICE_PANEL, open)
        return () => window.removeEventListener(OPEN_VOICE_PANEL, open)
    }, [])
    useEffect(() => { if (panelMode === 'auto') setPanel('auto') }, [panelMode])
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
            case 'ui_status': return {
                sessionId: options.sessionId, target: options.terminal ? 'terminal' : 'chat',
                draft: { hasText: Boolean(voice.draft?.trim()), alternatives: voice.alternatives?.length ?? 0,
                    pending: voice.deferred?.length ?? 0, sending: voice.sending, busy: voice.drafting,
                    language: panelSettings.language, alternativesEnabled: panelSettings.alternativesEnabled,
                    panel, mode: panelMode, autoSend: { enabled: autoSend.enabled, delay: autoSend.delay } },
                mic: { enabled: voice.micOn, sensitivity: getVoiceSensitivity() },
                readback: { enabled: readback.enabled, language: readback.language, playing: readback.playing }
            }
            case 'draft_clear': voice.clearDraft(); break
            case 'draft_send':
                if (!voice.draft.trim() || voice.sending || voice.draftIssue) return { error: 'Draft is empty, busy, or requires attention.' }
                void voice.sendDraft()
                return { requested: 'send', delivered: false }
            case 'draft_choose': {
                const candidate = voice.alternatives[command.index - 1]
                if (!candidate || voice.sending) return { error: 'Candidate is unavailable or draft is busy.' }
                setPanel('open')
                voice.beginDraftEdit()
                voice.editDraft(candidate)
                voice.endDraftEdit()
                break
            }
            case 'draft_pending':
                if (!voice.deferred[command.index - 1] || voice.sending) return { error: 'Pending fragment is unavailable or draft is busy.' }
                voice.resolveSpeech(command.index - 1, command.include)
                break
            case 'mic_enabled': if (voice.micOn !== command.enabled) voice.toggle(); break
            case 'readback_devices': return readback.output ?? { devices: [], status: 'unavailable' }
            case 'readback_output':
                if (!readback.output || !(['speaker', 'system'].includes(command.device) || readback.output.devices.some(device => device.deviceId === command.device))) return { error: 'Output device is unavailable. Use readback devices.' }
                readback.selectOutput(command.device)
                return { requested: command.device, applied: false }
            case 'list_sessions': {
                setSearch('')
                const recent = options.sessions.filter(s => s.active && s.id !== options.sessionId)
                    .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5)
                choicesRef.current = recent
                setChoices(recent)
                return {
                    choices: recent.map((s, i) => ({ index: i + 1, directory: s.metadata?.path, child: Boolean(s.parentSessionId || s.metadata?.subagent), title: s.metadata?.name || s.metadata?.summary?.text || s.metadata?.path || s.id })),
                    ...(command.query ? {
                        sessions: options.sessions.filter(session => session.active).map(session => ({ id: session.id, title: session.metadata?.name || session.metadata?.summary?.text || session.metadata?.path || session.id, recentActivity: session.activity?.text ?? '' }))
                    } : {})
                }
            }
            case 'switch_session': {
                const selected = options.sessions.find(session => session.active && session.id === command.sessionId)
                if (!selected) return { error: '该会话已停止或不在当前列表中。' }
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
                if (!selected || !options.sessions.some(s => s.id === selected.id && s.active)) return { error: '当前展示列表中没有这一项，请先获取会话列表。' }
                choicesRef.current = null
                setChoices(null)
                options.navigate(selected.id)
                return { selected: command.index }
            }
            case 'cancel_selection': choicesRef.current = null; setChoices(null); break
            case 'draft_language': panelSettings.setLanguage(command.language); break
            case 'draft_alternatives': panelSettings.setAlternativesEnabled(command.enabled); break
            case 'draft_mode': panelSettings.setMode(command.mode); break
            case 'mic_sensitivity': setVoiceSensitivity(command.value); break
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
            case 'readback_language': readback.setLanguage(command.language); break
            case 'readback': readback.setEnabled(command.enabled); break
            case 'draft_panel': setPanel(command.open ? 'open' : 'closed'); break
            case 'reset_voice': choicesRef.current = null; setChoices(null); setPanel(panelMode === 'auto' ? 'auto' : 'closed'); voice.resetHistory(); break
        }
        return { ok: true }
    }
    const voice = useOmniVoice({ ...options, target: options.terminal ? 'terminal' : 'chat', writeTerminal: writer ?? undefined,
        onSpeechStart: () => { if (panelMode === 'auto') setPanel('auto') }, onUiControl: control, selectingSession: choices !== null, autoSendBlocked: panel === 'closed' || (panelMode === 'manual' && panel !== 'open') || choices !== null })

    return { voice: { ...voice, beginDraftEdit: () => { setPanel('open'); voice.beginDraftEdit() }, clearDraft: () => { if (panelMode === 'auto') setPanel('auto'); voice.clearDraft() } }, readback, panel, setPanel, choices, search, answerStatus, control, registerWriter }
}
