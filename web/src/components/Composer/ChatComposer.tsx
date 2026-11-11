import { ComposerPrimitive, useAssistantApi, useAssistantState } from '@assistant-ui/react'
import {
    forwardRef,
    useCallback,
    useContext,
    useEffect,
    useImperativeHandle,
    useMemo,
    useRef,
    useState,
    type ChangeEvent,
    type ClipboardEvent,
    type KeyboardEvent,
    type ReactNode,
    type SyntheticEvent
} from 'react'
import { createPortal, flushSync } from 'react-dom'
import type { ApiClient } from '@/api/client'
import { AttachmentItem } from '@/components/AssistantChat/AttachmentItem'
import { areComposerAttachmentsReady } from '@/components/AssistantChat/composerAttachments'
import { QuickPhrasesPanel } from '@/components/AssistantChat/QuickPhrasesPanel'
import { Autocomplete } from '@/components/ChatInput/Autocomplete'
import { FloatingOverlay } from '@/components/ChatInput/FloatingOverlay'
import { createPerformanceReportFile, isPerformanceReportAvailable } from '@/components/PerformanceMonitor'
import { ComposerDockContext } from '@/components/Session/composerDock'
import { useToolbarPreferences } from '@/components/Session/toolbarProfiles'
import { useActiveSuggestions, type Suggestion } from '@/hooks/useActiveSuggestions'
import { useActiveWord } from '@/hooks/useActiveWord'
import { useDictation } from '@/hooks/useDictation'
import { isTrustedEmbed } from '@/hooks/useEmbedRouteReport'
import { usePlatform } from '@/hooks/usePlatform'
import { usePWAInstall } from '@/hooks/usePWAInstall'
import { useWorkspaceLayout } from '@/hooks/useWorkspaceLayout'
import { useOptionalAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import type { QuickPhraseAction } from '@/types/api'
import { applySuggestion } from '@/utils/applySuggestion'
import { ComposerActionBar, type ComposerAction, type ComposerItem } from './ComposerActionBar'
import { AbortIcon, KeyboardIcon } from './icons'

const DICTATION_ERROR_KEYS: Record<string, string> = {
    notConfigured: 'composer.dictation.notConfigured',
    micPermission: 'voice.error.micPermission'
}

const NO_SUGGESTIONS = async (): Promise<Suggestion[]> => []

export type ComposerSuggestions = {
    prefixes: string[]
    load: (query: string) => Promise<Suggestion[]>
    /** What replaces the active word; a conversation may also act on the pick here. */
    resolve?: (suggestion: Suggestion) => { text: string; addSpace: boolean }
}

export type ChatComposerHandle = {
    /** Reveals a docked composer and focuses the input. Call within a tap: iOS only raises the keyboard then. */
    open: () => void
}

export type ChatComposerProps = {
    /** The controls this conversation offers, in display order. */
    items: ComposerItem[]
    disabled: boolean
    placeholder: string
    ariaLabel?: string
    api?: ApiClient
    suggestions?: ComposerSuggestions
    /** Lets a conversation intercept sending: `null` is the draft, a string is a quick phrase on its own. */
    requestSend?: (phrase: string | null) => void
    /** Gets the keys the composer leaves alone. */
    onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void
    dock?: {
        status?: { text: string; dotColor: string; isPulsing: boolean }
        abort?: { spinning: boolean; onAbort: () => void }
    }
    /** Above the input box, such as status. */
    above?: ReactNode
    /** Inside the input box, above the text, such as what is being replied to. */
    inputHeader?: ReactNode
    children?: ReactNode
}

/** Sends through the runtime: `null` sends the draft, a string sends a quick phrase and leaves the draft alone. */
export function useComposerSend() {
    const api = useAssistantApi()
    return useCallback((phrase: string | null) => {
        if (phrase === null) api.composer().send()
        else api.thread().append(phrase)
    }, [api])
}

export const ChatComposer = forwardRef<ChatComposerHandle, ChatComposerProps>(function ChatComposer(props, ref) {
    const { t } = useTranslation()
    // Thread guest pages have no app context, and so no dictation.
    const { baseUrl = '', token = '', guest } = useOptionalAppContext() ?? {}
    const api = useAssistantApi()
    const composerText = useAssistantState(({ composer }) => composer.text)
    const attachments = useAssistantState(({ composer }) => composer.attachments)
    const threadIsDisabled = useAssistantState(({ thread }) => thread.isDisabled)
    const send = useComposerSend()
    const requestSend = props.requestSend ?? send

    const controlsDisabled = props.disabled || threadIsDisabled
    const attachmentsReady = areComposerAttachmentsReady(attachments)
    const hasContent = composerText.trim().length > 0 || attachments.length > 0
    const canSend = hasContent && attachmentsReady && !controlsDisabled

    const [inputState, setInputState] = useState({ text: '', selection: { start: 0, end: 0 } })
    const [openPanel, setOpenPanel] = useState<string | null>(null)
    const closePanel = useCallback(() => setOpenPanel(null), [])
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const containerRef = useRef<HTMLDivElement>(null)
    const rootRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        setInputState(previous => {
            if (previous.text === composerText) return previous
            // Keep the cursor at the end when the text changes from outside, so word detection stays correct.
            const end = composerText.length
            return { text: composerText, selection: { start: end, end } }
        })
    }, [composerText])

    const { haptic: platformHaptic, isTouch } = usePlatform()
    const tap = useCallback(() => platformHaptic.impact('light'), [platformHaptic])

    // ---- Dock: the workspace toolbar hosts the toggle; the composer stays mounted while hidden, keeping its draft.
    const dock = useContext(ComposerDockContext)
    const inlineComposer = useWorkspaceLayout().composer === 'inline'
    const { preferences, update } = useToolbarPreferences()
    const dockOpen = preferences.composerOpen ?? inlineComposer
    const hidden = dock !== null && !dockOpen
    // The opened docked composer floats over the chat (fixed to the visual viewport, see index.css):
    // reserve space after the whole conversation, including the mobile title footer.
    useEffect(() => {
        const el = rootRef.current
        if (!dock || !dockOpen || !el || typeof ResizeObserver === 'undefined') return
        const root = document.documentElement
        const observer = new ResizeObserver(() => root.style.setProperty('--composer-height', `${el.offsetHeight}px`))
        observer.observe(el)
        return () => {
            observer.disconnect()
            root.style.removeProperty('--composer-height')
        }
    }, [dock, dockOpen])
    const open = useCallback(() => {
        const root = document.documentElement
        const atBottom = root.scrollHeight - window.scrollY - window.innerHeight < 80
        const reveal = hidden
        if (reveal) flushSync(() => update({ composerOpen: true }))
        textareaRef.current?.focus()
        if (reveal && root.classList.contains('doc-scroll') && atBottom) {
            requestAnimationFrame(() => {
                const composer = rootRef.current
                if (!composer?.offsetHeight) return
                root.style.setProperty('--composer-height', `${composer.offsetHeight}px`)
                composer.closest('.conversation-chat')?.querySelector('[data-conversation-header="bottom"]')
                    ?.scrollIntoView({ block: 'end', behavior: 'instant' })
            })
        }
    }, [hidden, update])
    useImperativeHandle(ref, () => ({ open }), [open])

    // ---- Panels: at most one is open.
    const togglePanel = useCallback((id: string) => {
        tap()
        setOpenPanel(current => (current === id ? null : id))
    }, [tap])
    useEffect(() => {
        if (!openPanel) return
        const pointer = (event: PointerEvent) => {
            if (!containerRef.current?.contains(event.target as Node | null)) setOpenPanel(null)
        }
        const escape = (event: globalThis.KeyboardEvent) => {
            if (event.key === 'Escape') setOpenPanel(null)
        }
        document.addEventListener('pointerdown', pointer)
        document.addEventListener('keydown', escape)
        return () => {
            document.removeEventListener('pointerdown', pointer)
            document.removeEventListener('keydown', escape)
        }
    }, [openPanel])

    // ---- Suggestions
    const prefixes = props.suggestions?.prefixes ?? EMPTY_PREFIXES
    const activeWord = useActiveWord(inputState.text, inputState.selection, prefixes)
    const [suggestions, selectedIndex, moveUp, moveDown, clearSuggestions] = useActiveSuggestions(
        activeWord,
        props.suggestions?.load ?? NO_SUGGESTIONS,
        { clampSelection: true, wrapAround: true }
    )
    const replaceText = useCallback((text: string, cursor: number) => {
        api.composer().setText(text)
        setInputState({ text, selection: { start: cursor, end: cursor } })
        setTimeout(() => {
            const el = textareaRef.current
            if (!el) return
            el.setSelectionRange(cursor, cursor)
            try {
                el.focus({ preventScroll: true })
            } catch {
                el.focus()
            }
        }, 0)
    }, [api])
    const selectSuggestion = useCallback((index: number) => {
        const suggestion = suggestions[index]
        if (!suggestion || !textareaRef.current) return
        const { text, addSpace } = props.suggestions?.resolve?.(suggestion) ?? { text: suggestion.text, addSpace: true }
        const result = applySuggestion(inputState.text, inputState.selection, text, prefixes, addSpace)
        replaceText(result.text, result.cursorPosition)
        tap()
    }, [suggestions, props.suggestions, inputState, prefixes, replaceText, tap])

    const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        // Avoid intercepting IME composition keystrokes (Enter, arrows, etc.)
        if (event.nativeEvent.isComposing) return
        const { key } = event
        if (key === 'Escape' && openPanel) {
            event.preventDefault()
            setOpenPanel(null)
            return
        }
        if (key === 'Enter' && event.shiftKey) return
        if (suggestions.length > 0) {
            const selected = selectedIndex >= 0 ? selectedIndex : 0
            if (key === 'Enter' || (key === 'Tab' && !event.shiftKey)) {
                event.preventDefault()
                selectSuggestion(selected)
                return
            }
            if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'Escape') {
                event.preventDefault()
                if (key === 'ArrowUp') moveUp()
                else if (key === 'ArrowDown') moveDown()
                else clearSuggestions()
                return
            }
        }
        // Only plain Enter sends; other modifier combos are ignored.
        if (key === 'Enter') {
            event.preventDefault()
            if (!event.ctrlKey && !event.altKey && !event.metaKey && canSend) requestSend(null)
            return
        }
        props.onKeyDown?.(event)
    }

    const handleChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
        setInputState({ text: event.target.value, selection: { start: event.target.selectionStart, end: event.target.selectionEnd } })
    }, [])
    const handleSelect = useCallback((event: SyntheticEvent<HTMLTextAreaElement>) => {
        const target = event.target as HTMLTextAreaElement
        setInputState(previous => ({ ...previous, selection: { start: target.selectionStart, end: target.selectionEnd } }))
    }, [])
    const acceptsAttachments = props.items.includes('attachments')
    const handlePaste = useCallback(async (event: ClipboardEvent<HTMLTextAreaElement>) => {
        if (!acceptsAttachments) return
        const images = Array.from(event.clipboardData?.files || []).filter(file => file.type.startsWith('image/'))
        if (images.length === 0) return
        event.preventDefault()
        try {
            for (const file of images) await api.composer().addAttachment(file)
        } catch (error) {
            console.error('Error adding pasted image:', error)
        }
    }, [acceptsAttachments, api])

    const pickQuickPhrase = useCallback((phrase: string, action: QuickPhraseAction) => {
        setOpenPanel(null)
        tap()
        if (action === 'send') {
            requestSend(phrase)
            return
        }
        // The textarea keeps its selection while the panel has focus, so it is the source of truth.
        const el = textareaRef.current
        const start = el?.selectionStart ?? composerText.length
        const end = el?.selectionEnd ?? composerText.length
        replaceText(composerText.slice(0, start) + phrase + composerText.slice(end), start + phrase.length)
    }, [composerText, replaceText, requestSend, tap])

    // ---- Dictation: its text replaces the selection the textarea had when recording started.
    // Only guests dictate here; the owner talks through the workspace voice orb.
    const dictationAvailable = guest?.voiceEnabled ?? false
    const [dictationError, setDictationError] = useState<string | null>(null)
    const dictationAnchor = useRef({ before: '', after: '' })
    const dictation = useDictation({
        baseUrl,
        token,
        onText: transcript => {
            const { before, after } = dictationAnchor.current
            const text = before + transcript + after
            const cursor = before.length + transcript.length
            api.composer().setText(text)
            setInputState({ text, selection: { start: cursor, end: cursor } })
        },
        onError: error => setDictationError(DICTATION_ERROR_KEYS[error] ? t(DICTATION_ERROR_KEYS[error]) : error)
    })
    const toggleDictation = () => {
        tap()
        if (dictation.state !== 'idle') {
            dictation.stop()
            return
        }
        const el = textareaRef.current
        const start = el?.selectionStart ?? composerText.length
        const end = el?.selectionEnd ?? composerText.length
        dictationAnchor.current = { before: composerText.slice(0, start), after: composerText.slice(end) }
        setDictationError(null)
        void dictation.start()
    }

    const performanceReportAvailable = useMemo(() => isPerformanceReportAvailable(), [])
    const items = props.items.filter(item => {
        if (item === 'performanceReport') return performanceReportAvailable
        if (item === 'quickPhrases') return Boolean(props.api) && !guest
        return true
    })
    const panelAction = items.find((item): item is ComposerAction => typeof item !== 'string' && item.id === openPanel && Boolean(item.panel))
    const overlay = openPanel === 'quickPhrases' && props.api ? (
        <FloatingOverlay maxHeight={320}>
            <QuickPhrasesPanel api={props.api} onPick={pickQuickPhrase} />
        </FloatingOverlay>
    ) : panelAction?.panel ? (
        <FloatingOverlay maxHeight={panelAction.panel.maxHeight}>{panelAction.panel.render(closePanel)}</FloatingOverlay>
    ) : suggestions.length > 0 ? (
        <FloatingOverlay>
            <Autocomplete suggestions={suggestions} selectedIndex={selectedIndex} onSelect={selectSuggestion} />
        </FloatingOverlay>
    ) : null

    // Embedded in the owner's dashboard (incl. the car frame): the composer takes focus only from his own tap on it,
    // never by itself (assistant-ui refocuses on run start, scroll to bottom, thread switch). The textarea is marked
    // for the tap-only focus guard (lib/embedFocusGuard), which also blocks every other programmatic focus.
    const embedded = useMemo(() => isTrustedEmbed(), [])
    const { isStandalone, isIOS } = usePWAInstall()
    const status = props.dock?.status
    const abort = props.dock?.abort

    return (
        <div ref={rootRef} className={`doc-sticky-bottom px-3 ${isIOS && isStandalone ? 'pb-0' : 'pb-3'} pt-2 bg-[var(--app-bg)] ${hidden ? 'hidden' : ''}`}>
            {dock ? createPortal(
                <>
                    <button
                        type="button"
                        onClick={() => {
                            if (dockOpen) update({ composerOpen: false })
                            else open()
                        }}
                        className={`relative flex h-9 w-9 items-center justify-center rounded-md transition-colors ${dockOpen ? 'bg-[var(--app-subtle-bg)] text-[var(--app-fg)]' : 'text-[var(--app-hint)]'}`}
                        title={status?.text ?? t('composer.toggleInput')}
                        aria-label={t('composer.toggleInput')}
                        aria-pressed={dockOpen}
                    >
                        <KeyboardIcon />
                        {status ? <span className={`absolute right-1 top-1 h-2 w-2 rounded-full ${status.dotColor} ${status.isPulsing ? 'animate-pulse' : ''}`} /> : null}
                    </button>
                    {abort ? (
                        <button
                            type="button"
                            onClick={abort.onAbort}
                            className="flex h-9 w-9 items-center justify-center rounded-md text-[var(--app-fg)]"
                            title={t('composer.abort')}
                            aria-label={t('composer.abort')}
                        >
                            <AbortIcon spinning={abort.spinning} />
                        </button>
                    ) : null}
                </>,
                dock
            ) : null}
            <div ref={containerRef} className="mx-auto w-full max-w-content">
                <ComposerPrimitive.Root
                    className="relative"
                    onSubmit={event => {
                        if (!attachmentsReady) event.preventDefault()
                    }}
                >
                    {overlay ? <div className="absolute bottom-[100%] mb-2 w-full">{overlay}</div> : null}
                    {props.above}
                    <div className="overflow-hidden rounded-[20px] bg-[var(--app-secondary-bg)]">
                        {attachments.length > 0 ? (
                            <div className="flex flex-wrap gap-2 px-4 pt-3">
                                <ComposerPrimitive.Attachments components={{ Attachment: AttachmentItem }} />
                            </div>
                        ) : null}
                        {props.inputHeader}
                        <div className="flex items-center px-4 py-3">
                            <ComposerPrimitive.Input
                                ref={textareaRef}
                                aria-label={props.ariaLabel}
                                autoFocus={!controlsDisabled && !isTouch && !embedded}
                                unstable_focusOnRunStart={!embedded}
                                unstable_focusOnScrollToBottom={!embedded}
                                unstable_focusOnThreadSwitched={!embedded}
                                data-hapi-composer={embedded ? '' : undefined}
                                placeholder={props.placeholder}
                                disabled={controlsDisabled}
                                maxRows={5}
                                submitOnEnter={false}
                                cancelOnEscape={false}
                                onChange={handleChange}
                                onSelect={handleSelect}
                                onKeyDown={handleKeyDown}
                                onPaste={handlePaste}
                                className="flex-1 resize-none bg-transparent text-base leading-snug text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                            />
                        </div>
                        {dictationError ? <div className="px-4 pb-1 text-xs text-red-500">{dictationError}</div> : null}
                        <ComposerActionBar
                            items={items}
                            disabled={controlsDisabled}
                            canSend={canSend}
                            onSend={() => requestSend(null)}
                            onAction={action => {
                                if (action.panel) togglePanel(action.id)
                                action.onClick?.()
                            }}
                            onAttachPerformanceReport={() => void api.composer().addAttachment(createPerformanceReportFile())}
                            onToggleQuickPhrases={() => togglePanel('quickPhrases')}
                            dictationState={dictation.state}
                            onDictationToggle={dictationAvailable ? toggleDictation : undefined}
                        />
                    </div>
                </ComposerPrimitive.Root>
            </div>
            {props.children}
        </div>
    )
})

const EMPTY_PREFIXES: string[] = []
