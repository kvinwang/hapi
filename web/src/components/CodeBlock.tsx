import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useShikiHighlighter } from '@/lib/shiki'
import { useWordWrap, toggleWordWrap } from '@/hooks/useWordWrap'
import { CopyIcon, CheckIcon, WrapIcon } from '@/components/icons'
import { useTranslation } from '@/lib/use-translation'

export function CodeBlock(props: {
    code: string
    language?: string
    showCopyButton?: boolean
}) {
    const { t } = useTranslation()
    const showCopyButton = props.showCopyButton ?? true
    const wrapLongLines = useWordWrap()
    const { copied, copy } = useCopyToClipboard()
    const highlighted = useShikiHighlighter(props.code, props.language)

    return (
        <div className="relative min-w-0 max-w-full">
            {showCopyButton ? (
                <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5">
                    <button
                        type="button"
                        onClick={toggleWordWrap}
                        className={wrapLongLines
                            ? 'rounded p-1 text-[var(--app-fg)] bg-[var(--app-subtle-bg)] transition-colors'
                            : 'rounded p-1 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors'}
                        title="Word Wrap"
                    >
                        <WrapIcon className="h-3.5 w-3.5" />
                    </button>
                    <button
                        type="button"
                        onClick={() => copy(props.code)}
                        className="rounded p-1 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
                        title={t('code.copy')}
                    >
                        {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
                    </button>
                </div>
            ) : null}

            <div className={wrapLongLines
                ? 'min-w-0 w-full max-w-full overflow-x-hidden overflow-y-hidden rounded-md bg-[var(--app-code-bg)]'
                : 'min-w-0 w-full max-w-full overflow-x-auto overflow-y-hidden rounded-md bg-[var(--app-code-bg)]'}
            >
                <pre className={wrapLongLines
                    ? 'shiki m-0 min-w-0 w-full whitespace-pre-wrap break-words p-2 pr-16 text-xs font-mono'
                    : 'shiki m-0 w-max min-w-full p-2 pr-16 text-xs font-mono'}
                >
                    <code className="block">{highlighted ?? props.code}</code>
                </pre>
            </div>
        </div>
    )
}
