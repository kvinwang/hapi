import { ComposerPrimitive } from '@assistant-ui/react'
import type { ReactNode } from 'react'
import { StarIcon } from '@/components/icons'
import type { DictationState } from '@/hooks/useDictation'
import { useTranslation } from '@/lib/use-translation'
import { AttachmentIcon, MicIcon, PerformanceIcon, SendIcon } from './icons'

/** A control a conversation adds to the composer: runs `onClick`, or toggles `panel` above the input. */
export type ComposerAction = {
    id: string
    label: string
    icon: ReactNode
    onClick?: () => void
    panel?: { maxHeight?: number; render: (close: () => void) => ReactNode }
    disabled?: boolean
    /** Replaces the default colours. */
    className?: string
    attributes?: Record<string, string>
}

/** Controls the composer implements itself; a conversation opts in by listing them. */
export type ComposerBuiltin = 'attachments' | 'performanceReport' | 'quickPhrases'

export type ComposerItem = ComposerAction | ComposerBuiltin

const BUTTON = 'flex h-8 w-8 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50'
const IDLE = 'text-[var(--app-fg)]/60 hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]'

export function ComposerActionBar(props: {
    items: ComposerItem[]
    disabled: boolean
    canSend: boolean
    onSend: () => void
    onAction: (action: ComposerAction) => void
    onAttachPerformanceReport: () => void
    onToggleQuickPhrases: () => void
    dictationState?: DictationState
    onDictationToggle?: () => void
}) {
    const { t } = useTranslation()
    const button = (action: ComposerAction) => (
        <button
            key={action.id}
            type="button"
            aria-label={action.label}
            title={action.label}
            disabled={action.disabled}
            className={`${BUTTON} ${action.className ?? IDLE}`}
            onClick={() => props.onAction(action)}
            {...action.attributes}
        >
            {action.icon}
        </button>
    )
    const dictating = props.dictationState !== undefined && props.dictationState !== 'idle'
    const dictationLabel = t(dictating ? 'composer.dictation.stop' : 'composer.dictation.start')
    return (
        <div className="flex items-center justify-between px-2 pb-2">
            <div className="flex items-center gap-1">
                {props.items.map(item => {
                    if (item === 'attachments') {
                        return (
                            <ComposerPrimitive.AddAttachment
                                key={item}
                                aria-label={t('composer.attach')}
                                title={t('composer.attach')}
                                disabled={props.disabled}
                                className={`${BUTTON} ${IDLE}`}
                            >
                                <AttachmentIcon />
                            </ComposerPrimitive.AddAttachment>
                        )
                    }
                    if (item === 'performanceReport') {
                        return button({
                            id: item,
                            label: t('composer.attachPerformanceReport'),
                            icon: <PerformanceIcon />,
                            disabled: props.disabled,
                            onClick: props.onAttachPerformanceReport
                        })
                    }
                    if (item === 'quickPhrases') {
                        return button({
                            id: item,
                            label: t('settings.nav.quickPhrases'),
                            icon: <StarIcon width={18} height={18} />,
                            disabled: props.disabled,
                            onClick: props.onToggleQuickPhrases
                        })
                    }
                    return button(item)
                })}
            </div>
            <div className="flex items-center gap-1">
                {props.onDictationToggle ? (
                    <button
                        type="button"
                        aria-label={dictationLabel}
                        title={dictationLabel}
                        aria-pressed={dictating}
                        disabled={props.disabled || props.dictationState === 'stopping'}
                        className={`${BUTTON} ${dictating ? 'animate-pulse bg-red-500 text-white' : IDLE}`}
                        onClick={props.onDictationToggle}
                    >
                        <MicIcon />
                    </button>
                ) : null}
                <button
                    type="button"
                    onClick={props.onSend}
                    disabled={props.disabled || !props.canSend}
                    aria-label={t('composer.send')}
                    title={t('composer.send')}
                    className={`${BUTTON} ${props.canSend ? 'bg-black text-white' : 'bg-[#C0C0C0] text-white'}`}
                >
                    <SendIcon />
                </button>
            </div>
        </div>
    )
}
