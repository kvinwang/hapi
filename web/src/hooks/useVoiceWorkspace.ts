import { useVoiceAutoSendSettings } from './useVoiceAutoSend'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import type { VoiceUiControl } from '@/lib/voiceUiControl'
import { useAiReadback } from './useAiReadback'
import { useOmniVoice } from './useOmniVoice'

export function useVoiceWorkspace(options: { api: ApiClient; baseUrl: string; token: string; sessionId: string; terminal: boolean; sessions: SessionSummary[]; navigate: (id: string) => void }) {
    const [writer, setWriter] = useState<((text: string) => boolean) | null>(null)
    const registerWriter = useCallback((next: ((text: string) => boolean) | null) => setWriter(() => next), [])
    const [panel, setPanel] = useState<'auto' | 'closed'>('auto')
    const [choices, setChoices] = useState<SessionSummary[] | null>(null)
    const [search, setSearch] = useState('')
    const choicesRef = useRef(choices)
    choicesRef.current = choices
    useEffect(() => { choicesRef.current = null; setChoices(null) }, [options.sessionId])
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
                const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '')
                const query = normalize(command.query)
                if (!query) return { error: 'A title keyword is required.' }
                const title = (session: SessionSummary) => session.metadata?.name || session.metadata?.summary?.text || session.metadata?.path || session.id
                const active = options.sessions.filter(session => session.active)
                const exact = active.filter(session => normalize(title(session)) === query)
                const matches = (exact.length ? exact : active.filter(session => normalize(title(session)).includes(query)))
                    .sort((a, b) => b.updatedAt - a.updatedAt)
                if (matches.length === 1) {
                    choicesRef.current = null
                    setChoices(null)
                    options.navigate(matches[0].id)
                    return { selectedTitle: title(matches[0]) }
                }
                const candidates = matches.slice(0, 5)
                choicesRef.current = candidates
                setSearch(command.query)
                setChoices(candidates)
                return { matches: matches.length, choices: candidates.map((session, index) => ({ index: index + 1, title: title(session), directory: session.metadata?.path })), instruction: matches.length ? 'Ask the user to choose a displayed number or provide more specific title keywords.' : 'No matching active session. Ask for different title keywords.' }
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
            case 'readback': readback.setEnabled(command.enabled); break
            case 'draft_panel': setPanel(command.open ? 'auto' : 'closed'); break
            case 'reset_voice': choicesRef.current = null; setChoices(null); setPanel('auto'); voice.resetHistory(); break
        }
        return { ok: true }
    }
    const voice = useOmniVoice({ ...options, target: options.terminal ? 'terminal' : 'chat', writeTerminal: writer ?? undefined,
        onSpeechStart: () => setPanel('auto'), onUiControl: control, selectingSession: choices !== null, autoSendBlocked: panel === 'closed' || choices !== null,
        uiContext: JSON.stringify({ autoSend: { enabled: autoSend.enabled, delay: autoSend.delay }, readback: readback.enabled, draftPanel: panel, sessionChoices: choices?.map((s, i) => ({ index: i + 1, directory: s.metadata?.path, child: Boolean(s.parentSessionId || s.metadata?.subagent), title: s.metadata?.name || s.metadata?.summary?.text || s.id })) ?? null }) })
    return { voice: { ...voice, clearDraft: () => { setPanel('auto'); voice.clearDraft() } }, readback, panel, setPanel, choices, search, control, registerWriter }
}
