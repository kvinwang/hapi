import { ProviderModelPicker } from './ProviderModelPicker'
import {
    getEffortModeLabel,
    getCodexEffortOptions,
    getEffortModesForFlavor,
    getModelModeLabel,
    getPermissionModeOptionsForFlavor,
    GROK_MODEL_MODES,
    MODEL_MODES,
    normalizeDetectedClaudeModelMode,
    type EffortMode,
    type CodexEffortOption
} from '@hapi/protocol'
import type { CodexModelInfo, Metadata } from '@hapi/protocol/types'
import { getCodexModelOptions } from '@/lib/codexModelOptions'
import { useAssistantApi, useAssistantState } from '@assistant-ui/react'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { AgentState, ModelMode, ModelPricing, PermissionMode } from '@/types/api'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import type { ConversationStatus } from '@/realtime/types'
import type { LatestUsage } from '@/chat/reducer'
import { useAppContext } from '@/lib/app-context'
import { usePlatform } from '@/hooks/usePlatform'
import { isClaudeFlavor, isGrokFlavor, supportsEffortMode, supportsModelModeSwitch } from '@/lib/agentFlavorUtils'
import { markSkillUsed } from '@/lib/recent-skills'
import type { ApiClient } from '@/api/client'
import { AgentSettingsPanel } from '@/components/AssistantChat/AgentSettingsPanel'
import { ChatComposer, useComposerSend } from '@/components/Composer/ChatComposer'
import type { ComposerItem } from '@/components/Composer/ComposerActionBar'
import { AbortIcon, ClearContextIcon, MoreIcon, SettingsIcon, SpeakerIcon, SwitchToRemoteIcon, TerminalIcon, UsageIcon, UserMessagesIcon } from '@/components/Composer/icons'
import { StatusBar, getConnectionStatus } from '@/components/AssistantChat/StatusBar'
import { UsagePanel } from '@/components/AssistantChat/UsagePanel'
import { GoalPanel } from '@/components/AssistantChat/GoalPanel'
import { useTranslation } from '@/lib/use-translation'
import { calculateUsageCost, formatUsd } from '@/chat/usageCost'
import { getContextBudgetTokens } from '@/chat/modelConfig'
import { formatIdleDuration } from '@/chat/staleCacheWarning'
import { useStaleCacheGuard } from '@/components/AssistantChat/useStaleCacheGuard'
import { StaleCacheDialog } from '@/components/AssistantChat/StaleCacheDialog'

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

const DEFAULT_PREFIXES = ['@', '/', '$']
const defaultSuggestionHandler = async (): Promise<Suggestion[]> => []

/** The composer of a coding agent session: agent settings, usage, stale-cache guard and run control. */
export function HappyComposer(props: {
    disabled?: boolean
    permissionMode?: PermissionMode
    modelMode?: ModelMode
    codexProvider?: Metadata['codexProvider'] | Metadata['piProvider'] | Metadata['claudeProvider'] | Metadata['geminiProvider'] | Metadata['opencodeProvider']
    resolvedModel?: string
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
    codexModels?: CodexModelInfo[] | null
    /** Agent-reported model catalog (Codex app-server, Grok ACP, etc.). */
    agentModelCatalog?: Metadata['agentModelCatalog'] | null
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
        codexModels,
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
        autocompletePrefixes = DEFAULT_PREFIXES,
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
    // Codex prefers its live app-server catalog, then machine discovery, then static fallback.
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
            const models = agentModelCatalog?.length
                ? agentModelCatalog.map((entry) => ({
                    value: entry.id,
                    displayName: entry.name ?? entry.id,
                    description: entry.description
                }))
                : codexModels
            options = getCodexModelOptions({ models, currentModel: modelMode })
                .map(({ value, ...option }) => ({ mode: value, ...option }))
        } else if (claudeModels && claudeModels.length > 0) {
            options = claudeModels.map((m) => ({
                mode: normalizeDetectedClaudeModelMode(m.value),
                label: m.displayName,
                description: m.description
            }))
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
    }, [agentFlavor, agentModelCatalog, claudeModels, codexModels, modelMode])

    const effortModeOptions = useMemo<CodexEffortOption[]>(
        () => agentFlavor === 'codex'
            ? getCodexEffortOptions({
                modelMode,
                resolvedModel: props.resolvedModel,
                agentModelCatalog,
                machineModels: codexModels
            })
            : getEffortModesForFlavor(agentFlavor).map((mode) => ({
                mode,
                label: getEffortModeLabel(mode)
            })),
        [agentFlavor, modelMode, props.resolvedModel, agentModelCatalog, codexModels]
    )

    const supportsModelSwitch = supportsModelModeSwitch(agentFlavor)
    const supportsEffort = supportsEffortMode(agentFlavor) && effortModeOptions.length > 0

    const api = useAssistantApi()
    const composerText = useAssistantState(({ composer }) => composer.text)
    const threadIsRunning = useAssistantState(({ thread }) => thread.isRunning)
    const threadIsDisabled = useAssistantState(({ thread }) => thread.isDisabled)
    const controlsDisabled = disabled || (!active && !allowSendWhenInactive) || threadIsDisabled

    const [isAborting, setIsAborting] = useState(false)
    const [isSwitching, setIsSwitching] = useState(false)
    const [showContinueHint, setShowContinueHint] = useState(false)
    const [modelPricing, setModelPricing] = useState<ModelPricing | null>(null)
    const prevControlledByUser = useRef(controlledByUser)
    const { guest } = useAppContext()
    // Usage and cost are the owner's business.
    const isGuest = Boolean(guest)
    const pricingModel = contextModel ?? sessionUsage?.model
    const usageCost = calculateUsageCost(sessionUsage, modelPricing)

    const send = useComposerSend()
    const sendMessage = useCallback((phrase: string | null) => {
        send(phrase)
        setShowContinueHint(false)
    }, [send])

    // A session left idle for an hour has lost its prompt cache, so the next message re-reads the
    // whole conversation at full input price. Intercepting the send here rather than downstream
    // keeps the user's text in the composer if they decide against it.
    const {
        warning: staleCacheWarning,
        requestSend,
        confirmSend: confirmStaleCacheSend,
        dismissWarning: dismissStaleCacheWarning
    } = useStaleCacheGuard<string | null>({
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
    }, sendMessage)

    // The idle gap is usually a natural break, so the default is to start fresh; the `~` prefix
    // tells the agent its context was just cleared.
    const clearAndSendStale = useCallback(() => {
        props.onClearContext?.()
        const withClearPrefix = (text: string) => (text.trimStart().startsWith('~') ? text : `~ ${text}`)
        confirmStaleCacheSend((phrase) => {
            if (phrase !== null) return withClearPrefix(phrase)
            api.composer().setText(withClearPrefix(composerText))
            return null
        })
    }, [api, composerText, confirmStaleCacheSend, props.onClearContext])

    useEffect(() => {
        let cancelled = false
        if (!apiClient || !pricingModel || isGuest) {
            setModelPricing(null)
            return
        }
        void apiClient.getModelPricing(pricingModel)
            .then((result) => { if (!cancelled) setModelPricing(result.pricing) })
            .catch(() => { if (!cancelled) setModelPricing(null) })
        return () => { cancelled = true }
    }, [apiClient, pricingModel, isGuest])

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

    const { haptic: platformHaptic } = usePlatform()
    const tap = useCallback(() => platformHaptic.impact('light'), [platformHaptic])

    // Keep the button clickable while aborting so a second press can escalate
    // a graceful interrupt into a hard abort (handled by the session's onAbort).
    const abortDisabled = !threadIsRunning
    const switchDisabled = controlsDisabled || isSwitching || !controlledByUser

    useEffect(() => {
        if (isAborting && !threadIsRunning) setIsAborting(false)
    }, [isAborting, threadIsRunning])

    useEffect(() => {
        if (isSwitching && !controlledByUser) setIsSwitching(false)
    }, [isSwitching, controlledByUser])

    const handleAbort = useCallback(() => {
        if (abortDisabled) return
        platformHaptic.notification('error')
        setIsAborting(true)
        api.thread().cancelRun()
    }, [abortDisabled, api, platformHaptic])

    const handleSwitch = useCallback(async () => {
        if (switchDisabled || !onSwitchToRemote) return
        tap()
        setIsSwitching(true)
        try {
            await onSwitchToRemote()
        } catch {
            setIsSwitching(false)
        }
    }, [switchDisabled, onSwitchToRemote, tap])

    const permissionModeOptions = useMemo(
        () => getPermissionModeOptionsForFlavor(agentFlavor),
        [agentFlavor]
    )

    const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === 'Escape' && threadIsRunning) {
            event.preventDefault()
            handleAbort()
            return
        }
        if (event.key === 'Tab' && event.shiftKey && onPermissionModeChange && permissionModeOptions.length > 0) {
            event.preventDefault()
            const modes = permissionModeOptions.map((option) => option.mode)
            onPermissionModeChange(modes[(modes.indexOf(permissionMode) + 1) % modes.length] ?? 'default')
            tap()
        }
    }

    useEffect(() => {
        const handleGlobalKeyDown = (e: globalThis.KeyboardEvent) => {
            if (e.key === 'm' && (e.metaKey || e.ctrlKey) && onModelModeChange && supportsModelSwitch) {
                e.preventDefault()
                const currentIndex = modelModeOptions.findIndex((option) => option.mode === modelMode)
                const nextIndex = (currentIndex + 1) % modelModeOptions.length
                onModelModeChange(modelModeOptions[nextIndex].mode)
                tap()
            }
        }

        window.addEventListener('keydown', handleGlobalKeyDown)
        return () => window.removeEventListener('keydown', handleGlobalKeyDown)
    }, [modelMode, modelModeOptions, onModelModeChange, tap, supportsModelSwitch])

    const suggestions = useMemo(() => ({
        prefixes: autocompletePrefixes,
        load: autocompleteSuggestions,
        resolve: (suggestion: Suggestion) => {
            if (suggestion.text.startsWith('$')) markSkillUsed(suggestion.text.slice(1))
            // For Codex user prompts with content, expand the content instead of command name
            return agentFlavor === 'codex' && suggestion.source !== 'builtin' && suggestion.content
                ? { text: suggestion.content, addSpace: false }
                : { text: suggestion.text, addSpace: true }
        }
    }), [agentFlavor, autocompletePrefixes, autocompleteSuggestions])

    const showPermissionSettings = Boolean(onPermissionModeChange && permissionModeOptions.length > 0)
    const showModelSettings = Boolean(onModelModeChange && supportsModelSwitch)
    const showEffortSettings = Boolean(onEffortModeChange && supportsEffort)
    const usesProviderPicker = (agentFlavor === 'codex' || agentFlavor === 'pi' || agentFlavor === 'claude') && apiClient && sessionId

    const items: ComposerItem[] = ['attachments', 'performanceReport']
    if (showPermissionSettings || showModelSettings || showEffortSettings) {
        items.push({
            id: 'settings',
            label: t('composer.settings'),
            icon: <SettingsIcon />,
            disabled: controlsDisabled,
            panel: {
                maxHeight: 360,
                render: (close) => {
                    const choose = <Mode,>(apply: ((mode: Mode) => void) | undefined) => (mode: Mode) => {
                        if (!apply || controlsDisabled) return
                        apply(mode)
                        close()
                        tap()
                    }
                    return (
                        <AgentSettingsPanel
                            disabled={controlsDisabled}
                            permission={showPermissionSettings ? { options: permissionModeOptions, selected: permissionMode, onSelect: choose(onPermissionModeChange) } : undefined}
                            modelPicker={showModelSettings && usesProviderPicker ? (
                                <ProviderModelPicker
                                    api={apiClient}
                                    sessionId={sessionId}
                                    provider={props.codexProvider}
                                    model={modelMode}
                                    models={modelModeOptions}
                                    disabled={controlsDisabled}
                                    providerSwitchDisabled={!active || thinking || controlledByUser}
                                    onModelChange={choose(onModelModeChange)}
                                />
                            ) : undefined}
                            model={showModelSettings ? { options: modelModeOptions, selected: modelMode, onSelect: choose(onModelModeChange) } : undefined}
                            effort={showEffortSettings ? { options: effortModeOptions, selected: effortMode, onSelect: choose(onEffortModeChange) } : undefined}
                        />
                    )
                }
            }
        })
    }
    if (!isGuest && ((apiClient && sessionId) || sessionUsage)) {
        items.push({
            id: 'usage',
            label: t('composer.usage'),
            icon: <UsageIcon />,
            disabled: controlsDisabled,
            panel: {
                maxHeight: 280,
                render: () => (
                    <UsagePanel
                        api={apiClient}
                        sessionId={sessionId}
                        sessionUsage={sessionUsage}
                        agentFlavor={agentFlavor}
                        contextWindowTokens={contextWindowTokens}
                        model={contextModel}
                        pricing={modelPricing}
                    />
                )
            }
        })
    }
    items.push('quickPhrases')
    if (onUserMessagesToggle) {
        const label = t(userMessagesOpen ? 'chat.userPanel.hide' : 'chat.userPanel.show')
        items.push({
            id: 'userMessages',
            label,
            icon: <UserMessagesIcon />,
            disabled: controlsDisabled,
            onClick: onUserMessagesToggle,
            attributes: { 'data-user-panel-toggle': 'true' },
            className: `hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] ${userMessagesOpen ? 'bg-[var(--app-bg)] text-[var(--app-fg)]' : 'text-[var(--app-fg)]/60'}`
        })
    }
    if (onTerminal || terminalUnsupported) {
        items.push({
            id: 'terminal',
            label: terminalUnsupported ? t('terminal.unsupportedWindows') : t('composer.terminal'),
            icon: <TerminalIcon />,
            disabled: controlsDisabled || terminalUnsupported,
            onClick: onTerminal,
            className: 'text-[var(--app-fg)]/60 hover:bg-[var(--app-bg)] hover:text-emerald-500'
        })
    }
    items.push({
        id: 'abort',
        label: t('composer.abort'),
        icon: <AbortIcon spinning={isAborting} />,
        disabled: abortDisabled,
        onClick: handleAbort,
        className: 'text-[var(--app-fg)]/60 hover:bg-[var(--app-bg)] hover:text-red-500'
    })
    if (controlledByUser && onSwitchToRemote) {
        items.push({
            id: 'switch',
            label: t('composer.switchRemote'),
            icon: <SwitchToRemoteIcon />,
            disabled: switchDisabled,
            onClick: () => void handleSwitch(),
            className: 'text-[var(--app-fg)]/60 hover:bg-[var(--app-bg)] hover:text-blue-500'
        })
    }
    if (voiceStatus === 'connected' && onVoiceMicToggle) {
        items.push({
            id: 'voiceMic',
            label: t(voiceMicMuted ? 'voice.unmute' : 'voice.mute'),
            icon: <SpeakerIcon muted={voiceMicMuted} />,
            onClick: onVoiceMicToggle,
            className: voiceMicMuted ? 'bg-gray-200 text-gray-600 hover:bg-gray-300' : undefined
        })
    }
    if (props.onClearContext) {
        const clearContext = props.onClearContext
        items.push({
            id: 'more',
            label: t('composer.more'),
            icon: <MoreIcon />,
            disabled: controlsDisabled,
            panel: {
                maxHeight: 200,
                render: (close) => (
                    <div className="py-1">
                        <button
                            type="button"
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-secondary-bg)]"
                            onClick={() => {
                                close()
                                clearContext()
                            }}
                            onMouseDown={(e) => e.preventDefault()}
                        >
                            <ClearContextIcon />
                            {t('composer.clearContext')}
                        </button>
                    </div>
                )
            }
        })
    }

    return (
        <ChatComposer
            items={items}
            disabled={controlsDisabled}
            placeholder={showContinueHint ? t('misc.typeMessage') : t('misc.typeAMessage')}
            api={apiClient}
            suggestions={suggestions}
            requestSend={requestSend}
            onKeyDown={handleKeyDown}
            dock={{
                status: getConnectionStatus(active, thinking, agentState, voiceStatus, t),
                abort: threadIsRunning ? { spinning: isAborting, onAbort: handleAbort } : undefined
            }}
            above={<>
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
                    providerName={props.codexProvider?.name}
                    modelMode={modelMode}
                    permissionMode={permissionMode}
                    agentFlavor={agentFlavor}
                    voiceStatus={voiceStatus}
                    totalCost={isGuest ? undefined : props.sessionUsage?.reportedCostUsd ?? usageCost?.total}
                />
            </>}
        >
            <StaleCacheDialog
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
                ) : null}
                onClose={dismissStaleCacheWarning}
                onClearAndSend={props.onClearContext ? clearAndSendStale : undefined}
                onSendAnyway={confirmStaleCacheSend}
            />
        </ChatComposer>
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
