import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import type { VoiceUiControl } from '@/lib/voiceUiControl'
import { useAiReadback } from './useAiReadback'
import { useOmniVoice } from './useOmniVoice'

export function useVoiceWorkspace(options: { api: ApiClient; baseUrl: string; token: string; sessionId: string; terminal: boolean; sessions: SessionSummary[]; navigate: (id: string) => void }) {
    const [writer, setWriter] = useState<((text: string) => boolean) | null>(null)
    const registerWriter = useCallback((next: ((text: string) => boolean) | null) => setWriter(() => next), [])
    const [panel, setPanel] = useState<'auto' | 'open' | 'closed'>('auto')
    const [choices, setChoices] = useState<SessionSummary[] | null>(null)
    const choicesRef = useRef(choices)
    choicesRef.current = choices
    useEffect(() => { choicesRef.current = null; setChoices(null) }, [options.sessionId])
    const readback = useAiReadback(options)
    const control = (command: VoiceUiControl) => {
        switch (command.action) {
            case 'list_sessions': {
                const recent = options.sessions.filter(s => s.id !== options.sessionId && !s.parentSessionId)
                    .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5)
                choicesRef.current = recent
                setChoices(recent)
                return { choices: recent.map((s, i) => ({ index: i + 1, title: s.metadata?.name || s.metadata?.summary?.text || s.metadata?.path || s.id })) }
            }
            case 'select_session': {
                const selected = choicesRef.current?.[command.index - 1]
                if (!selected) return { error: 'No such entry in the displayed list. Call list_sessions first.' }
                choicesRef.current = null
                setChoices(null)
                options.navigate(selected.id)
                return { selected: command.index }
            }
            case 'cancel_selection': choicesRef.current = null; setChoices(null); break
            case 'readback': readback.setEnabled(command.enabled); break
            case 'draft_panel': setPanel(command.open ? 'open' : 'closed'); break
        }
        return { ok: true }
    }
    const voice = useOmniVoice({ ...options, target: options.terminal ? 'terminal' : 'chat', writeTerminal: writer ?? undefined,
        onUiControl: control, selectingSession: choices !== null, autoSendBlocked: panel === 'closed' || choices !== null,
        uiContext: JSON.stringify({ readback: readback.enabled, draftPanel: panel, sessionChoices: choices?.map((s, i) => ({ index: i + 1, title: s.metadata?.name || s.metadata?.summary?.text || s.id })) ?? null }) })
    return { voice, readback, panel, setPanel, choices, control, registerWriter }
}
