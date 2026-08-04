import {
    CODEX_MODEL_MODES,
    getEffortModeLabel,
    getEffortModesForFlavor,
    getModelModeLabel,
    getPermissionModeOptionsForFlavor,
    GROK_MODEL_MODES,
    MODEL_MODES,
    type EffortMode
} from '@hapi/protocol'
import { ComposerPrimitive, useAssistantApi, useAssistantState } from '@assistant-ui/react'
import {
    type ChangeEvent as ReactChangeEvent,
    type ClipboardEvent as ReactClipboardEvent,
    type FormEvent as ReactFormEvent,
    type KeyboardEvent as ReactKeyboardEvent,
    type SyntheticEvent as ReactSyntheticEvent,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState
} from 'react'
import type { AgentState, ModelMode, ModelPricing, PermissionMode } from '@/types/api'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import type { ConversationStatus } from '@/realtime/types'
import type { LatestUsage } from '@/chat/reducer'
import { useActiveWord } from '@/hooks/useActiveWord'
import { useActiveSuggestions } from '@/hooks/useActiveSuggestions'
import { applySuggestion } from '@/utils/applySuggestion'
import { usePlatform } from '@/hooks/usePlatform'
import { usePWAInstall } from '@/hooks/usePWAInstall'
import { isClaudeFlavor, isGrokFlavor, supportsEffortMode, supportsModelModeSwitch } from '@/lib/agentFlavorUtils'
import { markSkillUsed } from '@/lib/recent-skills'
import type { ApiClient } from '@/api/client'
import { FloatingOverlay } from '@/components/ChatInput/FloatingOverlay'
import { Autocomplete } from '@/components/ChatInput/Autocomplete'
import { StatusBar } from '@/components/AssistantChat/StatusBar'
import { ComposerButtons, ClearContextIcon } from '@/components/AssistantChat/ComposerButtons'
import { areComposerAttachmentsReady } from '@/components/AssistantChat/composerAttachments'
import { AttachmentItem } from '@/components/AssistantChat/AttachmentItem'
import { UsagePanel } from '@/components/AssistantChat/UsagePanel'
import { GoalPanel } from '@/components/AssistantChat/GoalPanel'
import { useTranslation } from '@/lib/use-translation'
import { calculateUsageCost, formatUsd } from '@/chat/usageCost'
import { getContextBudgetTokens } from '@/chat/modelConfig'
import { formatIdleDuration } from '@/chat/staleCacheWarning'
import { useStaleCacheGuard } from '@/components/AssistantChat/useStaleCacheGuard'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'

const GROK_MODEL_LABELS: Record<string, string> = {
    auto: 'Auto',
    'grok-4.5': 'Grok 4.5',
    'grok-composer-2.5-fast': 'Composer 2.5 Fast'
}

const CODEX_MODEL_LABELS: Record<string, string> = {
    auto: 'Auto',
    'gpt-5.4': 'GPT-5.4',
    'gpt-5.3-codex': 'GPT-5.3 Codex',
    'gpt-5.2-codex': 'GPT-5.2 Codex',
    'gpt-5.2': 'GPT-5.2',
    'gpt-5.1-codex-max': 'GPT-5.1 Codex Max',
    'gpt-5.1-codex-mini': 'GPT-5.1 Codex Mini'
}

export interface TextInputState {
    text: string
    selection: { start: number; end: number }
}

const defaultSuggestionHandler = async (): Promise<Suggestion[]> => []

export function HappyComposer(props: {
    disabled?: boolean
    permissionMode?: PermissionMode
    modelMode?: ModelMode
    effortMode?: EffortMode | string
    active?: boolean
    allowSendWhenInactive?: boolean
    thinking?: boolean
    agentState?: AgentState | null
    contextSize?: number
    contextModel?: string
    /** Agent-reported context window size (tokens). */
    contextWindowTokens?: number | null
    controlledByUser?: boolean
    agentFlavor?: string | null
    /** Account-specific Claude models detected on the session's machine; falls back to the static list. */
    claudeModels?: { value: string; displayName: string; description?: string }[] | null
    /** Agent-reported model catalog (Grok ACP, etc.). */
    agentModelCatalog?: { id: string; name?: string; description?: string; contextWindowTokens?: number }[] | null
    onPermissionModeChange?: (mode: PermissionMode) => void
    onModelModeChange?: (mode: ModelMode) => void
    onEffortModeChange?: (mode: EffortMode | string) => void
    onSwitchToRemote?: () => void
    onTerminal?: () => void
    terminalUnsupported?: boolean
    autocompletePrefixes?: string[]
    autocompleteSuggestions?: (query: string) => Promise<Suggestion[]>
    // Usage panel props
    apiClient?: ApiClient
    sessionId?: string
    /** Per-session token usage derived from chat messages (context bar / Grok fallback). */
    sessionUsage?: LatestUsage | null
    goalAvailable?: boolean
    goal?: {
        objective: string
        status: 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete'
        tokenBudget: number | null
        tokensUsed: number | null
        timeUsedSeconds: number
    } | null
    // Voice assistant props
    voiceStatus?: ConversationStatus
    voiceMicMuted?: boolean
    onVoiceMicToggle?: () => void
    userMessagesOpen?: boolean
    onUserMessagesToggle?: () => void
    onClearContext?: () => void
}) {
    const { t } = useTranslation()
    const {
        disabled = false,
        permissionMode: rawPermissionMode,
        modelMode: rawModelMode,
        effortMode: rawEffortMode,
        active = true,
        allowSendWhenInactive = false,
        thinking = false,
        agentState,
        contextSize,
        contextModel,
        contextWindowTokens,
        controlledByUser = false,
        agentFlavor,
        claudeModels,
        agentModelCatalog,
        sessionUsage,
        onPermissionModeChange,
        onModelModeChange,
        onEffortModeChange,
        onSwitchToRemote,
        onTerminal,
        apiClient,
        sessionId,
        terminalUnsupported = false,
        autocompletePrefixes = ['@', '/', '$'],
        autocompleteSuggestions = defaultSuggestionHandler,
        voiceStatus = 'disconnected',
        voiceMicMuted = false,
        onVoiceMicToggle,
        userMessagesOpen = false,
        onUserMessagesToggle
    } = props

    // Use ?? so missing values fall back to default (destructuring defaults only handle undefined)
    const permissionMode = rawPermissionMode ?? 'default'
    const modelMode = rawModelMode ?? 'default'
    const effortMode = rawEffortMode ?? 'default'

    // Model options: Claude uses account-detected list; Grok prefers ACP catalog then static list;
    // Codex uses static model list (or open-ended current value).
    const modelModeOptions = useMemo<{ mode: ModelMode; label: string; description?: string }[]>(() => {
        let options: { mode: ModelMode; label: string; description?: string }[]
        if (isGrokFlavor(agentFlavor)) {
            if (agentModelCatalog && agentModelCatalog.length > 0) {
                options = [
                    { mode: 'auto', label: GROK_MODEL_LABELS.auto ?? 'Auto' },
                    ...agentModelCatalog.map((entry) => ({
                        mode: entry.id,
                        label: entry.name ?? GROK_MODEL_LABELS[entry.id] ?? entry.id,
                        description: entry.description
                    }))
                ]
            } else {
                options = GROK_MODEL_MODES.map((mode) => ({
                    mode,
                    label: GROK_MODEL_LABELS[mode] ?? getModelModeLabel(mode)
                }))
            }
        } else if (agentFlavor === 'codex') {
            options = CODEX_MODEL_MODES.map((mode) => ({
                mode,
                label: CODEX_MODEL_LABELS[mode] ?? mode
            }))
        } else if (claudeModels && claudeModels.length > 0) {
            options = claudeModels.map((m) => ({ mode: m.value, label: m.displayName, description: m.description }))
        } else {
            options = MODEL_MODES.map((mode) => ({ mode, label: getModelModeLabel(mode) }))
        }
        if (!options.some((option) => option.mode === modelMode)) {
            options.push({
                mode: modelMode,
                label: GROK_MODEL_LABELS[modelMode]
                    ?? CODEX_MODEL_LABELS[modelMode]
                    ?? getModelModeLabel(modelMode)
            })
        }
        return options
    }, [agentFlavor, agentModelCatalog, claudeModels, modelMode])

    const effortModeOptions = useMemo(
        () => getEffortModesForFlavor(agentFlavor).map((mode) => ({
            mode,
            label: getEffortModeLabel(mode)
        })),
        [agentFlavor]
    )

    const supportsModelSwitch = supportsModelModeSwitch(agentFlavor)
    const supportsEffort = supportsEffortMode(agentFlavor) && effortModeOptions.length > 0

    const api = useAssistantApi()
    const composerText = useAssistantState(({ composer }) => composer.text)
    const attachments = useAssistantState(({ composer }) => composer.attachments)
    const threadIsRunning = useAssistantState(({ thread }) => thread.isRunning)
    const threadIsDisabled = useAssistantState(({ thread }) => thread.isDisabled)

    const controlsDisabled = disabled || (!active && !allowSendWhenInactive) || threadIsDisabled
    const trimmed = composerText.trim()
    const hasText = trimmed.length > 0
    const hasAttachments = attachments.length > 0
    const attachmentsReady = areComposerAttachmentsReady(attachments)
    const canSend = (hasText || hasAttachments) && attachmentsReady && !controlsDisabled

    const [inputState, setInputState] = useState<TextInputState>({
        text: '',
        selection: { start: 0, end: 0 }
    })
    const [showSettings, setShowSettings] = useState(false)
    const [showUsage, setShowUsage] = useState(false)
    const [showMenu, setShowMenu] = useState(false)
    const [isAborting, setIsAborting] = useState(false)
    const [isSwitching, setIsSwitching] = useState(false)
    const [showContinueHint, setShowContinueHint] = useState(false)
    const [modelPricing, setModelPricing] = useState<ModelPricing | null>(null)
    const pricingModel = contextModel ?? sessionUsage?.model
    const usageCost = calculateUsageCost(sessionUsage, modelPricing)

    const submitToComposer = useCallback(() => {
        api.composer().send()
        setShowContinueHint(false)
    }, [api])

    // A session left idle for an hour has lost its prompt cache, so the next message re-reads the
    // whole conversation at full input price. Intercepting the send here rather than downstream
    // keeps the user's text in the composer if they decide against it.
    const {
        warning: staleCacheWarning,
        requestSend,
        confirmSend: confirmStaleCacheSend,
        dismissWarning: dismissStaleCacheWarning
    } = useStaleCacheGuard({
        flavor: agentFlavor,
        lastUsageAt: sessionUsage?.timestamp,
        contextTokens: sessionUsage?.contextSize ?? contextSize,
        // Unlike the status bar meter, this falls back to the model-id heuristic when the agent has
        // not reported a window: a warning that silently never fires is worse than one sized from a
        // sensible default.
        contextBudgetTokens: getContextBudgetTokens(pricingModel, {
            windowTokens: contextWindowTokens,
            allowHeuristic: true
        }),
        pricing: modelPricing
    }, submitToComposer)

    useEffect(() => {
        let cancelled = false
        if (!apiClient || !pricingModel) {
            setModelPricing(null)
            return
        }
        void apiClient.getModelPricing(pricingModel)
            .then((result) => { if (!cancelled) setModelPricing(result.pricing) })
            .catch(() => { if (!cancelled) setModelPricing(null) })
        return () => { cancelled = true }
    }, [apiClient, pricingModel])

    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const composerContainerRef = useRef<HTMLDivElement>(null)
    const prevControlledByUser = useRef(controlledByUser)

    useEffect(() => {
        setInputState((prev) => {
            if (prev.text === composerText) return prev
            // When syncing from composerText, update selection to end of text
            // This ensures activeWord detection works correctly
            const newPos = composerText.length
            return { text: composerText, selection: { start: newPos, end: newPos } }
        })
    }, [composerText])

    // Track one-time "continue" hint after switching from local to remote.
    useEffect(() => {
        if (prevControlledByUser.current === true && controlledByUser === false) {
            setShowContinueHint(true)
        }
        if (controlledByUser) {
            setShowContinueHint(false)
        }
        prevControlledByUser.current = controlledByUser
    }, [controlledByUser])

    const { haptic: platformHaptic, isTouch } = usePlatform()
    const { isStandalone, isIOS } = usePWAInstall()
    const isIOSPWA = isIOS && isStandalone
    const bottomPaddingClass = isIOSPWA ? 'pb-0' : 'pb-3'
    const activeWord = useActiveWord(inputState.text, inputState.selection, autocompletePrefixes)
    const [suggestions, selectedIndex, moveUp, moveDown, clearSuggestions] = useActiveSuggestions(
        activeWord,
        autocompleteSuggestions,
        { clampSelection: true, wrapAround: true }
    )

    const haptic = useCallback((type: 'light' | 'success' | 'error' = 'light') => {
        if (type === 'light') {
            platformHaptic.impact('light')
        } else if (type === 'success') {
            platformHaptic.notification('success')
        } else {
            platformHaptic.notification('error')
        }
    }, [platformHaptic])

    const handleSuggestionSelect = useCallback((index: number) => {
        const suggestion = suggestions[index]
        if (!suggestion || !textareaRef.current) return
        if (suggestion.text.startsWith('$')) {
            markSkillUsed(suggestion.text.slice(1))
        }

        // For Codex user prompts with content, expand the content instead of command name
        let textToInsert = suggestion.text
        let addSpace = true
        if (agentFlavor === 'codex' && suggestion.source !== 'builtin' && suggestion.content) {
            textToInsert = suggestion.content
            addSpace = false
        }

        const result = applySuggestion(
            inputState.text,
            inputState.selection,
            textToInsert,
            autocompletePrefixes,
            addSpace
        )

        api.composer().setText(result.text)
        setInputState({
            text: result.text,
            selection: { start: result.cursorPosition, end: result.cursorPosition }
        })

        setTimeout(() => {
            const el = textareaRef.current
            if (!el) return
            el.setSelectionRange(result.cursorPosition, result.cursorPosition)
            try {
                el.focus({ preventScroll: true })
            } catch {
                el.focus()
            }
        }, 0)

        haptic('light')
    }, [api, suggestions, inputState, autocompletePrefixes, haptic, agentFlavor])

    // Keep the button clickable while aborting so a second press can escalate
    // a graceful interrupt into a hard abort (handled by the session's onAbort).
    const abortDisabled = !threadIsRunning
    const switchDisabled = controlsDisabled || isSwitching || !controlledByUser
    const showSwitchButton = Boolean(controlledByUser && onSwitchToRemote)
    const showTerminalButton = Boolean(onTerminal || terminalUnsupported)
    const terminalDisabled = controlsDisabled || terminalUnsupported
    const terminalLabel = terminalUnsupported ? t('terminal.unsupportedWindows') : t('composer.terminal')

    useEffect(() => {
        if (!isAborting) return
        if (threadIsRunning) return
        setIsAborting(false)
    }, [isAborting, threadIsRunning])

    useEffect(() => {
        if (!isSwitching) return
        if (controlledByUser) return
        setIsSwitching(false)
    }, [isSwitching, controlledByUser])

    useEffect(() => {
        if (!showSettings && !showUsage && !showMenu) return

        const handlePointerDown = (event: PointerEvent) => {
            const target = event.target as Node | null
            if (!target) return
            const root = composerContainerRef.current
            if (!root) return
            if (root.contains(target)) return
            setShowSettings(false)
            setShowUsage(false)
            setShowMenu(false)
        }

        document.addEventListener('pointerdown', handlePointerDown)
        return () => document.removeEventListener('pointerdown', handlePointerDown)
    }, [showSettings, showUsage, showMenu])

    const handleAbort = useCallback(() => {
        if (abortDisabled) return
        haptic('error')
        setIsAborting(true)
        api.thread().cancelRun()
    }, [abortDisabled, api, haptic])

    const handleSwitch = useCallback(async () => {
        if (switchDisabled || !onSwitchToRemote) return
        haptic('light')
        setIsSwitching(true)
        try {
            await onSwitchToRemote()
        } catch {
            setIsSwitching(false)
        }
    }, [switchDisabled, onSwitchToRemote, haptic])

    const permissionModeOptions = useMemo(
        () => getPermissionModeOptionsForFlavor(agentFlavor),
        [agentFlavor]
    )
    const permissionModes = useMemo(
        () => permissionModeOptions.map((option) => option.mode),
        [permissionModeOptions]
    )

    const handleKeyDown = useCallback((e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
        const key = e.key

        // Avoid intercepting IME composition keystrokes (Enter, arrows, etc.)
        if (e.nativeEvent.isComposing) {
            return
        }

        if (key === 'Escape' && (showSettings || showUsage || showMenu)) {
            e.preventDefault()
            setShowSettings(false)
            setShowUsage(false)
            setShowMenu(false)
            return
        }

        // Shift+Enter inserts a newline (standard behavior)
        if (key === 'Enter' && e.shiftKey) {
            return // let default textarea behavior handle newline
        }

        // Enter with suggestions visible: select the suggestion
        if (key === 'Enter' && suggestions.length > 0) {
            e.preventDefault()
            const indexToSelect = selectedIndex >= 0 ? selectedIndex : 0
            handleSuggestionSelect(indexToSelect)
            return
        }

        // Only plain Enter (no modifiers) sends; other modifier combos are ignored
        if (key === 'Enter') {
            e.preventDefault()
            if (!e.ctrlKey && !e.altKey && !e.metaKey && canSend) {
                requestSend()
            }
            return
        }

        if (suggestions.length > 0) {
            if (key === 'ArrowUp') {
                e.preventDefault()
                moveUp()
                return
            }
            if (key === 'ArrowDown') {
                e.preventDefault()
                moveDown()
                return
            }
            if ((key === 'Tab') && !e.shiftKey) {
                e.preventDefault()
                const indexToSelect = selectedIndex >= 0 ? selectedIndex : 0
                handleSuggestionSelect(indexToSelect)
                return
            }
            if (key === 'Escape') {
                e.preventDefault()
                clearSuggestions()
                return
            }
        }

        if (key === 'Escape' && threadIsRunning) {
            e.preventDefault()
            handleAbort()
            return
        }

        if (key === 'Tab' && e.shiftKey && onPermissionModeChange && permissionModes.length > 0) {
            e.preventDefault()
            const currentIndex = permissionModes.indexOf(permissionMode)
            const nextIndex = (currentIndex + 1) % permissionModes.length
            const nextMode = permissionModes[nextIndex] ?? 'default'
            onPermissionModeChange(nextMode)
            haptic('light')
        }
    }, [
        suggestions,
        selectedIndex,
        moveUp,
        moveDown,
        clearSuggestions,
        handleSuggestionSelect,
        threadIsRunning,
        handleAbort,
        showSettings,
        showUsage,
        showMenu,
        onPermissionModeChange,
        permissionMode,
        permissionModes,
        canSend,
        api,
        requestSend,
        haptic
    ])

    useEffect(() => {
        const handleGlobalKeyDown = (e: globalThis.KeyboardEvent) => {
            if (e.key === 'm' && (e.metaKey || e.ctrlKey) && onModelModeChange && supportsModelSwitch) {
                e.preventDefault()
                const currentIndex = modelModeOptions.findIndex((option) => option.mode === modelMode)
                const nextIndex = (currentIndex + 1) % modelModeOptions.length
                onModelModeChange(modelModeOptions[nextIndex].mode)
                haptic('light')
            }
        }

        window.addEventListener('keydown', handleGlobalKeyDown)
        return () => window.removeEventListener('keydown', handleGlobalKeyDown)
    }, [modelMode, modelModeOptions, onModelModeChange, haptic, supportsModelSwitch])

    const handleChange = useCallback((e: ReactChangeEvent<HTMLTextAreaElement>) => {
        const selection = {
            start: e.target.selectionStart,
            end: e.target.selectionEnd
        }
        setInputState({ text: e.target.value, selection })
    }, [])

    const handleSelect = useCallback((e: ReactSyntheticEvent<HTMLTextAreaElement>) => {
        const target = e.target as HTMLTextAreaElement
        setInputState(prev => ({
            ...prev,
            selection: { start: target.selectionStart, end: target.selectionEnd }
        }))
    }, [])

    const handlePaste = useCallback(async (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
        const files = Array.from(e.clipboardData?.files || [])
        const imageFiles = files.filter(file => file.type.startsWith('image/'))

        if (imageFiles.length === 0) return

        e.preventDefault()

        try {
            for (const file of imageFiles) {
                await api.composer().addAttachment(file)
            }
        } catch (error) {
            console.error('Error adding pasted image:', error)
        }
    }, [api])

    const handleSettingsToggle = useCallback(() => {
        haptic('light')
        setShowUsage(false)
        setShowMenu(false)
        setShowSettings(prev => !prev)
    }, [haptic])

    const handleUsageToggle = useCallback(() => {
        haptic('light')
        setShowSettings(false)
        setShowMenu(false)
        setShowUsage(prev => !prev)
    }, [haptic])

    const handleMenuToggle = useCallback(() => {
        haptic('light')
        setShowSettings(false)
        setShowUsage(false)
        setShowMenu(prev => !prev)
    }, [haptic])

    const handleSubmit = useCallback((event?: ReactFormEvent<HTMLFormElement>) => {
        if (event && !attachmentsReady) {
            event.preventDefault()
            return
        }
        setShowContinueHint(false)
    }, [attachmentsReady])

    const handlePermissionChange = useCallback((mode: PermissionMode) => {
        if (!onPermissionModeChange || controlsDisabled) return
        onPermissionModeChange(mode)
        setShowSettings(false)
        haptic('light')
    }, [onPermissionModeChange, controlsDisabled, haptic])

    const handleModelChange = useCallback((mode: ModelMode) => {
        if (!onModelModeChange || controlsDisabled) return
        onModelModeChange(mode)
        setShowSettings(false)
        haptic('light')
    }, [onModelModeChange, controlsDisabled, haptic])

    const handleEffortChange = useCallback((mode: EffortMode | string) => {
        if (!onEffortModeChange || controlsDisabled) return
        onEffortModeChange(mode)
        setShowSettings(false)
        haptic('light')
    }, [onEffortModeChange, controlsDisabled, haptic])

    const showPermissionSettings = Boolean(onPermissionModeChange && permissionModeOptions.length > 0)
    const showModelSettings = Boolean(onModelModeChange && supportsModelSwitch)
    const showEffortSettings = Boolean(onEffortModeChange && supportsEffort)
    const showSettingsButton = Boolean(showPermissionSettings || showModelSettings || showEffortSettings)
    const showUsageButton = Boolean((apiClient && sessionId) || sessionUsage)
    const showAbortButton = true
    const handleClearContext = useCallback(() => {
        setShowMenu(false)
        props.onClearContext?.()
    }, [props.onClearContext])

    const handleSend = useCallback(() => {
        requestSend()
    }, [requestSend])

    const overlays = useMemo(() => {
        if (showSettings && (showPermissionSettings || showModelSettings || showEffortSettings)) {
            return (
                <div className="absolute bottom-[100%] mb-2 w-full">
                    <FloatingOverlay maxHeight={360}>
                        {showPermissionSettings ? (
                            <div className="py-2">
                                <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                                    {t('misc.permissionMode')}
                                </div>
                                {permissionModeOptions.map((option) => (
                                    <button
                                        key={option.mode}
                                        type="button"
                                        disabled={controlsDisabled}
                                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                                            controlsDisabled
                                                ? 'cursor-not-allowed opacity-50'
                                                : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                                        }`}
                                        onClick={() => handlePermissionChange(option.mode)}
                                        onMouseDown={(e) => e.preventDefault()}
                                    >
                                        <div
                                            className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                                permissionMode === option.mode
                                                    ? 'border-[var(--app-link)]'
                                                    : 'border-[var(--app-hint)]'
                                            }`}
                                        >
                                            {permissionMode === option.mode && (
                                                <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                                            )}
                                        </div>
                                        <span className={permissionMode === option.mode ? 'text-[var(--app-link)]' : ''}>
                                            {option.label}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        ) : null}

                        {showPermissionSettings && (showModelSettings || showEffortSettings) ? (
                            <div className="mx-3 h-px bg-[var(--app-divider)]" />
                        ) : null}

                        {showModelSettings ? (
                            <div className="py-2">
                                <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                                    {t('misc.model')}
                                </div>
                                {modelModeOptions.map(({ mode, label, description }) => (
                                    <button
                                        key={mode}
                                        type="button"
                                        disabled={controlsDisabled}
                                        className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm transition-colors ${
                                            controlsDisabled
                                                ? 'cursor-not-allowed opacity-50'
                                                : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                                        }`}
                                        onClick={() => handleModelChange(mode)}
                                        onMouseDown={(e) => e.preventDefault()}
                                    >
                                        <div
                                            className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${
                                                modelMode === mode
                                                    ? 'border-[var(--app-link)]'
                                                    : 'border-[var(--app-hint)]'
                                            }`}
                                        >
                                            {modelMode === mode && (
                                                <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                                            )}
                                        </div>
                                        <span className="flex min-w-0 flex-col">
                                            <span className={modelMode === mode ? 'text-[var(--app-link)]' : ''}>
                                                {label}
                                            </span>
                                            {description ? (
                                                <span className="text-xs text-[var(--app-hint)]">
                                                    {description}
                                                </span>
                                            ) : null}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        ) : null}

                        {showModelSettings && showEffortSettings ? (
                            <div className="mx-3 h-px bg-[var(--app-divider)]" />
                        ) : null}

                        {showEffortSettings ? (
                            <div className="py-2">
                                <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                                    {t('misc.effort')}
                                </div>
                                {effortModeOptions.map(({ mode, label }) => (
                                    <button
                                        key={mode}
                                        type="button"
                                        disabled={controlsDisabled}
                                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                                            controlsDisabled
                                                ? 'cursor-not-allowed opacity-50'
                                                : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                                        }`}
                                        onClick={() => handleEffortChange(mode)}
                                        onMouseDown={(e) => e.preventDefault()}
                                    >
                                        <div
                                            className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                                effortMode === mode
                                                    ? 'border-[var(--app-link)]'
                                                    : 'border-[var(--app-hint)]'
                                            }`}
                                        >
                                            {effortMode === mode && (
                                                <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                                            )}
                                        </div>
                                        <span className={effortMode === mode ? 'text-[var(--app-link)]' : ''}>
                                            {label}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        ) : null}
                    </FloatingOverlay>
                </div>
            )
        }

        if (showUsage && (apiClient || sessionUsage)) {
            return (
                <div className="absolute bottom-[100%] mb-2 w-full">
                    <FloatingOverlay maxHeight={280}>
                        <UsagePanel
                            api={apiClient}
                            sessionId={sessionId}
                            sessionUsage={sessionUsage}
                            agentFlavor={agentFlavor}
                            contextWindowTokens={contextWindowTokens}
                            model={contextModel}
                            pricing={modelPricing}
                        />
                    </FloatingOverlay>
                </div>
            )
        }

        if (showMenu && props.onClearContext) {
            return (
                <div className="absolute bottom-[100%] mb-2 w-full">
                    <FloatingOverlay maxHeight={200}>
                        <div className="py-1">
                            <button
                                type="button"
                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-secondary-bg)]"
                                onClick={handleClearContext}
                                onMouseDown={(e) => e.preventDefault()}
                            >
                                <ClearContextIcon />
                                {t('composer.clearContext')}
                            </button>
                        </div>
                    </FloatingOverlay>
                </div>
            )
        }

        if (suggestions.length > 0) {
            return (
                <div className="absolute bottom-[100%] mb-2 w-full">
                    <FloatingOverlay>
                        <Autocomplete
                            suggestions={suggestions}
                            selectedIndex={selectedIndex}
                            onSelect={(index) => handleSuggestionSelect(index)}
                        />
                    </FloatingOverlay>
                </div>
            )
        }

        return null
    }, [
        showSettings,
        showUsage,
        showMenu,
        apiClient,
        sessionId,
        sessionUsage,
        agentFlavor,
        showPermissionSettings,
        showModelSettings,
        showEffortSettings,
        suggestions,
        selectedIndex,
        controlsDisabled,
        permissionMode,
        modelMode,
        effortMode,
        permissionModeOptions,
        effortModeOptions,
        handlePermissionChange,
        handleModelChange,
        handleEffortChange,
        handleSuggestionSelect,
        handleClearContext,
        t
    ])

    return (
        <div className={`px-3 ${bottomPaddingClass} pt-2 bg-[var(--app-bg)]`}>
            <div ref={composerContainerRef} className="mx-auto w-full max-w-content">
                <ComposerPrimitive.Root className="relative" onSubmit={handleSubmit}>
                    {overlays}

                    {props.goalAvailable && apiClient && sessionId ? (
                        <GoalPanel api={apiClient} sessionId={sessionId} goal={props.goal} active={active} />
                    ) : null}

                    <StatusBar
                        active={active}
                        thinking={thinking}
                        agentState={agentState}
                        contextSize={contextSize}
                        model={contextModel}
                        contextWindowTokens={contextWindowTokens}
                        modelMode={modelMode}
                        permissionMode={permissionMode}
                        agentFlavor={agentFlavor}
                        voiceStatus={voiceStatus}
                        totalCost={props.sessionUsage?.reportedCostUsd ?? usageCost?.total}
                    />

                    <div className="overflow-hidden rounded-[20px] bg-[var(--app-secondary-bg)]">
                        {attachments.length > 0 ? (
                            <div className="flex flex-wrap gap-2 px-4 pt-3">
                                <ComposerPrimitive.Attachments components={{ Attachment: AttachmentItem }} />
                            </div>
                        ) : null}

                        <div className="flex items-center px-4 py-3">
                            <ComposerPrimitive.Input
                                ref={textareaRef}
                                autoFocus={!controlsDisabled && !isTouch}
                                placeholder={showContinueHint ? t('misc.typeMessage') : t('misc.typeAMessage')}
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

                        <ComposerButtons
                            canSend={canSend}
                            controlsDisabled={controlsDisabled}
                            showSettingsButton={showSettingsButton}
                            onSettingsToggle={handleSettingsToggle}
                            showUsageButton={showUsageButton}
                            onUsageToggle={handleUsageToggle}
                            showUserMessagesButton={Boolean(onUserMessagesToggle)}
                            userMessagesOpen={userMessagesOpen}
                            onUserMessagesToggle={onUserMessagesToggle}
                            showTerminalButton={showTerminalButton}
                            terminalDisabled={terminalDisabled}
                            terminalLabel={terminalLabel}
                            onTerminal={onTerminal ?? (() => {})}
                            showAbortButton={showAbortButton}
                            abortDisabled={abortDisabled}
                            isAborting={isAborting}
                            onAbort={handleAbort}
                            showSwitchButton={showSwitchButton}
                            switchDisabled={switchDisabled}
                            isSwitching={isSwitching}
                            onSwitch={handleSwitch}
                            voiceStatus={voiceStatus}
                            voiceMicMuted={voiceMicMuted}
                            onVoiceMicToggle={onVoiceMicToggle}
                            onSend={handleSend}
                            onMenuToggle={props.onClearContext ? handleMenuToggle : undefined}
                        />
                    </div>
                </ComposerPrimitive.Root>
            </div>

            <ConfirmDialog
                isOpen={staleCacheWarning !== null}
                onClose={dismissStaleCacheWarning}
                title={t('dialog.staleCache.title')}
                description={staleCacheWarning ? t(
                    staleCacheWarning.extraCostUsd === null
                        ? 'dialog.staleCache.description'
                        : 'dialog.staleCache.descriptionWithCost',
                    {
                        idle: formatIdleDuration(staleCacheWarning.idleMs, t),
                        tokens: formatTokenCount(staleCacheWarning.contextTokens),
                        percent: Math.round(staleCacheWarning.contextPercent),
                        cost: staleCacheWarning.extraCostUsd === null
                            ? ''
                            : formatUsd(staleCacheWarning.extraCostUsd)
                    }
                ) : ''}
                confirmLabel={t('dialog.staleCache.confirm')}
                confirmingLabel={t('dialog.staleCache.confirm')}
                onConfirm={confirmStaleCacheSend}
                isPending={false}
            />
        </div>
    )
}

function formatTokenCount(tokens: number): string {
    if (tokens >= 1_000_000) {
        return `${(tokens / 1_000_000).toFixed(1)}M`
    }
    if (tokens >= 1_000) {
        return `${Math.round(tokens / 1_000)}k`
    }
    return String(tokens)
}
