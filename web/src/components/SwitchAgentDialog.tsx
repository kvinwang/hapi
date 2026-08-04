import { useEffect, useState } from 'react'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/use-translation'
import type { AgentType } from '@/components/NewSession/types'
import type { SwitchAgentOptions } from '@/hooks/mutations/useSessionActions'

const AGENTS: AgentType[] = ['claude', 'codex', 'cursor', 'gemini', 'grok', 'opencode']

function Toggle(props: {
    checked: boolean
    onChange: (checked: boolean) => void
    label: string
    description: string
    disabled?: boolean
}) {
    return (
        <label className="flex cursor-pointer items-start gap-2.5">
            <input
                type="checkbox"
                checked={props.checked}
                disabled={props.disabled}
                onChange={(event) => props.onChange(event.target.checked)}
                className="mt-0.5 accent-[var(--app-link)]"
            />
            <span className="min-w-0">
                <span className="block text-sm">{props.label}</span>
                <span className="block text-xs text-[var(--app-hint)]">{props.description}</span>
            </span>
        </label>
    )
}

/**
 * Hand the session to a different agent.
 *
 * The session id does not change, so the conversation stays one thread. Each agent keeps its own
 * transcript, which is why "reset context" is a choice rather than a consequence: by default a
 * returning agent picks up where it left off.
 */
export function SwitchAgentDialog(props: {
    isOpen: boolean
    onClose: () => void
    currentAgent: string | null | undefined
    hasDrivenBefore: (agent: AgentType) => boolean
    onSwitch: (options: SwitchAgentOptions) => Promise<unknown>
    isPending: boolean
}) {
    const { t } = useTranslation()
    const [targetAgent, setTargetAgent] = useState<AgentType>(() => (
        props.currentAgent === 'claude' ? 'codex' : 'claude'
    ))
    const [resetContext, setResetContext] = useState(false)
    const [injectCatchUpPrompt, setInjectCatchUpPrompt] = useState(true)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        if (props.isOpen) {
            setError(null)
        }
    }, [props.isOpen])

    const isCurrent = targetAgent === props.currentAgent
    const willResume = props.hasDrivenBefore(targetAgent) && !resetContext
    // Re-selecting the current agent is only meaningful as a restart with a clean transcript.
    const canSubmit = !props.isPending && (!isCurrent || resetContext)

    const handleSubmit = async () => {
        setError(null)
        try {
            await props.onSwitch({ targetAgent, resetContext, injectCatchUpPrompt })
            props.onClose()
        } catch (err) {
            setError(err instanceof Error && err.message ? err.message : t('dialog.error.default'))
        }
    }

    return (
        <Dialog open={props.isOpen} onOpenChange={(open) => !open && props.onClose()}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>{t('dialog.switchAgent.title')}</DialogTitle>
                    <DialogDescription className="mt-2">
                        {t('dialog.switchAgent.description')}
                    </DialogDescription>
                </DialogHeader>

                <div className="mt-4 flex flex-wrap gap-x-3 gap-y-2">
                    {AGENTS.map((agent) => (
                        <label key={agent} className="flex cursor-pointer items-center gap-1.5">
                            <input
                                type="radio"
                                name="switch-agent"
                                value={agent}
                                checked={targetAgent === agent}
                                onChange={() => setTargetAgent(agent)}
                                disabled={props.isPending}
                                className="accent-[var(--app-link)]"
                            />
                            <span className="text-sm capitalize">{agent}</span>
                            {agent === props.currentAgent ? (
                                <span className="text-xs text-[var(--app-hint)]">
                                    {t('dialog.switchAgent.current')}
                                </span>
                            ) : null}
                        </label>
                    ))}
                </div>

                <div className="mt-4 space-y-3">
                    <Toggle
                        checked={resetContext}
                        onChange={setResetContext}
                        disabled={props.isPending}
                        label={t('dialog.switchAgent.resetContext')}
                        description={props.hasDrivenBefore(targetAgent)
                            ? t('dialog.switchAgent.resetContextKnown', { agent: targetAgent })
                            : t('dialog.switchAgent.resetContextNew', { agent: targetAgent })}
                    />
                    <Toggle
                        checked={injectCatchUpPrompt}
                        onChange={setInjectCatchUpPrompt}
                        disabled={props.isPending}
                        label={t('dialog.switchAgent.catchUp')}
                        description={willResume
                            ? t('dialog.switchAgent.catchUpResume')
                            : t('dialog.switchAgent.catchUpCold')}
                    />
                </div>

                {isCurrent && !resetContext ? (
                    <div className="mt-3 text-xs text-[var(--app-hint)]">
                        {t('dialog.switchAgent.alreadyCurrent')}
                    </div>
                ) : null}

                {error ? (
                    <div className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
                        {error}
                    </div>
                ) : null}

                <div className="mt-4 flex justify-end gap-2">
                    <Button type="button" variant="secondary" onClick={props.onClose} disabled={props.isPending}>
                        {t('button.cancel')}
                    </Button>
                    <Button type="button" variant="secondary" onClick={handleSubmit} disabled={!canSubmit}>
                        {props.isPending
                            ? t('dialog.switchAgent.switching')
                            : t('dialog.switchAgent.confirm')}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    )
}
