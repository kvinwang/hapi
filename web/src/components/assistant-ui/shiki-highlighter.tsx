import type { SyntaxHighlighterProps } from '@assistant-ui/react-markdown'
import { useShikiHighlighter } from '@/lib/shiki'
import { useNearViewport } from '@/hooks/useNearViewport'
import { useWordWrap } from '@/hooks/useWordWrap'

export function SyntaxHighlighter(props: SyntaxHighlighterProps) {
    const [ref, nearViewport] = useNearViewport<HTMLDivElement>()
    const highlighted = useShikiHighlighter(props.code, props.language, nearViewport)
    const wordWrap = useWordWrap()

    return (
        <div ref={ref} className={wordWrap
            ? 'aui-md-codeblock min-w-0 w-full max-w-full overflow-x-hidden overflow-y-hidden rounded-b-md bg-[var(--app-code-bg)]'
            : 'aui-md-codeblock min-w-0 w-full max-w-full overflow-x-auto overflow-y-hidden rounded-b-md bg-[var(--app-code-bg)]'}
        >
            <pre className={wordWrap
                ? 'shiki m-0 min-w-0 w-full whitespace-pre-wrap break-words p-2 text-sm font-mono'
                : 'shiki m-0 w-max min-w-full p-2 text-sm font-mono'}
            >
                <code className="block">{highlighted ?? props.code}</code>
            </pre>
        </div>
    )
}
