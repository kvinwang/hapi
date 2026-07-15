import type { ToolViewComponent, ToolViewProps } from '@/components/ToolCard/views/_all'
import { isObject, safeStringify } from '@hapi/protocol'
import { stripAnsiAndControls } from '@/components/assistant-ui/markdown-utils'
import { CodeBlock } from '@/components/CodeBlock'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { ChecklistList, extractTodoChecklist } from '@/components/ToolCard/checklist'
import { basename, resolveDisplayPath } from '@/utils/path'
import { getInputStringAny, isShellToolCall } from '@/lib/toolInputUtils'

function parseToolUseError(message: string): { isToolUseError: boolean; errorMessage: string | null } {
    const regex = /<tool_use_error>(.*?)<\/tool_use_error>/s
    const match = message.match(regex)

    if (match) {
        return {
            isToolUseError: true,
            errorMessage: typeof match[1] === 'string' ? match[1].trim() : ''
        }
    }

    return { isToolUseError: false, errorMessage: null }
}

/** Normalize CLI/tool text for web display: strip ANSI + control chars. */
export function normalizeToolDisplayText(text: string): string {
    return stripAnsiAndControls(text)
}

function tryParseJson(text: string): unknown | undefined {
    const trimmed = text.trim()
    if (!trimmed) return undefined
    if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return undefined
    try {
        return JSON.parse(trimmed) as unknown
    } catch {
        return undefined
    }
}

function isContentBlockArray(value: unknown): value is unknown[] {
    if (!Array.isArray(value) || value.length === 0) return false
    // At least one entry looks like a Claude content block or plain string line.
    // Number-only arrays are byte buffers, not content blocks.
    if (value.every((entry) => typeof entry === 'number')) return false
    return value.some((entry) => {
        if (typeof entry === 'string') return true
        if (!isObject(entry) || Array.isArray(entry)) return false
        return entry.type === 'text' || typeof entry.text === 'string'
    })
}

/**
 * Grok / some ACP bridges serialize Buffer/Uint8Array shell output as a JSON
 * array of byte values: [91, 114, 101, ...] → "[remov...".
 */
export function isByteArray(value: unknown): value is number[] {
    if (!Array.isArray(value) || value.length === 0) return false
    // Allow moderately large outputs; refuse huge arrays to avoid UI freezes.
    if (value.length > 2_000_000) return false
    return value.every((entry) =>
        typeof entry === 'number'
        && Number.isInteger(entry)
        && entry >= 0
        && entry <= 255
    )
}

export function decodeByteArray(bytes: number[]): string {
    try {
        // Prefer TextDecoder for multi-byte UTF-8 correctness.
        if (typeof TextDecoder !== 'undefined') {
            return new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(bytes))
        }
    } catch {
        // fall through
    }
    // Fallback: latin1-ish mapping (good enough for ASCII CLI output).
    let out = ''
    for (const b of bytes) {
        out += String.fromCharCode(b)
    }
    return out
}

function extractTextFromContentBlock(block: unknown): string | null {
    if (typeof block === 'string') return block
    if (!isObject(block) || Array.isArray(block)) return null
    if (block.type === 'text' && typeof block.text === 'string') return block.text
    if (typeof block.text === 'string') return block.text
    // Some providers put shell output under content on a text-ish block.
    if (typeof block.content === 'string') return block.content
    return null
}

function joinContentBlocks(blocks: unknown[]): string | null {
    const parts = blocks
        .map(extractTextFromContentBlock)
        .filter((part): part is string => typeof part === 'string' && part.length > 0)
    return parts.length > 0 ? parts.join('\n') : null
}

/**
 * Coerce arbitrary tool-result field values into plain text.
 * Handles: strings, content-block arrays, UTF-8 byte arrays, JSON-encoded
 * content-block arrays, and nested {text|content|output|stdout|message} objects.
 */
function coerceFieldToText(value: unknown, depth: number = 0): string | null {
    if (depth > 4) return null
    if (value === null || value === undefined) return null

    if (typeof value === 'string') {
        const toolUseError = parseToolUseError(value)
        if (toolUseError.isToolUseError) {
            return toolUseError.errorMessage ?? ''
        }

        // JSON-encoded content-block array or stdout object — unwrap for display.
        const parsed = tryParseJson(value)
        if (parsed !== undefined) {
            const nested = coerceFieldToText(parsed, depth + 1)
            if (nested !== null) return nested
            // Real JSON data (not content blocks / bytes) — pretty-print.
            try {
                return JSON.stringify(parsed, null, 2)
            } catch {
                return value
            }
        }
        return value
    }

    // Arrays first — isObject([]) is true in JS, so handle before object branch.
    if (Array.isArray(value)) {
        if (isByteArray(value)) {
            return decodeByteArray(value)
        }
        if (isContentBlockArray(value)) {
            return joinContentBlocks(value)
        }
        // String[] log lines
        if (value.every((entry) => typeof entry === 'string')) {
            return value.join('\n')
        }
        return null
    }

    // Typed arrays (Uint8Array etc.) that survived transport.
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) {
        const view = value as ArrayBufferView
        const bytes = Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
        return decodeByteArray(bytes)
    }

    if (!isObject(value) || Array.isArray(value)) return null

    // Prefer explicit stream fields when present.
    if ('stdout' in value || 'stderr' in value) {
        const stdout = coerceFieldToText(value.stdout, depth + 1)
        const stderr = coerceFieldToText(value.stderr, depth + 1)
        const parts: string[] = []
        if (stdout && stdout.length > 0) parts.push(stdout)
        if (stderr && stderr.length > 0) parts.push(stderr)
        if (parts.length > 0) return parts.join('\n')
    }

    // Grok ACP shell result shape: { type: "Bash", output: number[] | string }
    for (const key of [
        'output',
        'content',
        'text',
        'message',
        'error',
        'formatted_output',
        'aggregated_output',
        'result'
    ] as const) {
        if (key in value) {
            const nested = coerceFieldToText(value[key], depth + 1)
            if (nested !== null) return nested
        }
    }

    // Nested data envelopes
    if (isObject(value.data) && !Array.isArray(value.data)) {
        const nested = coerceFieldToText(value.data, depth + 1)
        if (nested !== null) return nested
    }

    return null
}

export function extractTextFromResult(result: unknown, depth: number = 0): string | null {
    if (depth > 3) return null
    if (result === null || result === undefined) return null

    const direct = coerceFieldToText(result, depth)
    if (direct !== null) {
        return normalizeToolDisplayText(direct)
    }

    if (!isObject(result)) return null

    const nestedResult = isObject(result.result) ? result.result : null
    if (nestedResult) {
        const nestedText = extractTextFromResult(nestedResult, depth + 1)
        if (nestedText) return nestedText
    }

    const nestedData = isObject(result.data) ? result.data : null
    if (nestedData) {
        const nestedText = extractTextFromResult(nestedData, depth + 1)
        if (nestedText) return nestedText
    }

    const nestedOutput = isObject(result.output) ? result.output : null
    if (nestedOutput) {
        const nestedText = extractTextFromResult(nestedOutput, depth + 1)
        if (nestedText) return nestedText
    }

    return null
}

interface CodexBashOutput {
    exitCode: number | null
    wallTime: string | null
    output: string
}

function parseCodexBashOutput(text: string): CodexBashOutput | null {
    const exitMatch = text.match(/^Exit code:\s*(\d+)/m)
    const wallMatch = text.match(/^Wall time:\s*(.+)$/m)
    const outputMatch = text.match(/^Output:\n([\s\S]*)$/m)

    if (!exitMatch && !wallMatch && !outputMatch) return null

    return {
        exitCode: exitMatch ? parseInt(exitMatch[1], 10) : null,
        wallTime: wallMatch ? wallMatch[1].trim() : null,
        output: outputMatch ? outputMatch[1] : text
    }
}

export function getMutationResultRenderMode(text: string, state: string): { mode: 'code' | 'auto'; language?: string } {
    const isMultiline = text.split('\n').length > 3
    const mode = state === 'error' || isMultiline ? 'code' as const : 'auto' as const
    return { mode, language: mode === 'code' ? 'text' : undefined }
}

function looksLikeHtml(text: string): boolean {
    const trimmed = text.trimStart()
    return trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html') || trimmed.startsWith('<div') || trimmed.startsWith('<span')
}

/** True only when text is parseable JSON that is *not* just a content-block array. */
function looksLikeStructuredJson(text: string): boolean {
    const parsed = tryParseJson(text)
    if (parsed === undefined) return false
    // Content-block arrays should already have been unwrapped; if one slipped through, don't JSON-highlight it.
    if (isContentBlockArray(parsed)) return false
    // Plain string arrays are usually log lines dumped as JSON — show as text if short entries.
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) return false
    return true
}

function renderText(text: string, opts: { mode: 'markdown' | 'code' | 'auto'; language?: string } = { mode: 'auto' }) {
    const cleaned = normalizeToolDisplayText(text)

    if (opts.mode === 'code') {
        return <CodeBlock code={cleaned} language={opts.language ?? 'text'} />
    }

    if (opts.mode === 'markdown') {
        return <MarkdownRenderer content={cleaned} />
    }

    if (looksLikeHtml(cleaned)) {
        return <CodeBlock code={cleaned} language="html" />
    }

    if (looksLikeStructuredJson(cleaned)) {
        // Pretty-print when possible for readability.
        const parsed = tryParseJson(cleaned)
        const pretty = parsed !== undefined ? JSON.stringify(parsed, null, 2) : cleaned
        return <CodeBlock code={pretty} language="json" />
    }

    return <MarkdownRenderer content={cleaned} />
}

function placeholderForState(state: ToolViewProps['block']['tool']['state']): string {
    if (state === 'pending') return 'Waiting for permission…'
    if (state === 'running') return 'Running…'
    return '(no output)'
}

function RawJsonDevOnly(props: { value: unknown }) {
    if (!import.meta.env.DEV) return null
    if (props.value === null || props.value === undefined) return null

    return (
        <details className="mt-3">
            <summary className="cursor-pointer text-xs font-medium text-[var(--app-hint)]">
                Raw JSON
            </summary>
            <div className="mt-2">
                <CodeBlock code={safeStringify(props.value)} language="json" />
            </div>
        </details>
    )
}

function StdioBlock(props: { label: string; text: string; tone?: 'default' | 'error' }) {
    const cleaned = normalizeToolDisplayText(props.text)
    if (!cleaned) return null
    const labelClass = props.tone === 'error'
        ? 'text-xs font-medium text-red-500'
        : 'text-xs font-medium text-[var(--app-hint)]'
    return (
        <div className="flex flex-col gap-1 min-w-0">
            <div className={labelClass}>{props.label}</div>
            <CodeBlock code={cleaned} language="text" />
        </div>
    )
}

function extractStdoutStderr(result: unknown): { stdout: string | null; stderr: string | null } | null {
    if (!isObject(result)) return null

    const pickStream = (value: unknown): string | null => {
        const text = coerceFieldToText(value)
        return text !== null ? normalizeToolDisplayText(text) : null
    }

    const hasStdout = 'stdout' in result
    const hasStderr = 'stderr' in result
    if (hasStdout || hasStderr) {
        const stdout = hasStdout ? pickStream(result.stdout) : null
        const stderr = hasStderr ? pickStream(result.stderr) : null
        // Only claim stdio shape when at least one stream is present (even if empty).
        return { stdout, stderr }
    }

    const nested = isObject(result.output) ? result.output : null
    if (nested && ('stdout' in nested || 'stderr' in nested)) {
        return {
            stdout: 'stdout' in nested ? pickStream(nested.stdout) : null,
            stderr: 'stderr' in nested ? pickStream(nested.stderr) : null
        }
    }

    return null
}

function extractReadFileContent(result: unknown): { filePath: string | null; content: string } | null {
    if (!isObject(result)) return null
    const file = isObject(result.file) ? result.file : null
    if (!file) return null

    const content = typeof file.content === 'string' ? file.content : null
    if (content === null) return null

    const filePath = typeof file.filePath === 'string'
        ? file.filePath
        : typeof file.file_path === 'string'
            ? file.file_path
            : null

    return { filePath, content }
}

function extractLineList(text: string): string[] {
    return text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
}

function isProbablyMarkdownList(text: string): boolean {
    const trimmed = text.trimStart()
    return trimmed.startsWith('- ') || trimmed.startsWith('* ') || trimmed.startsWith('1. ')
}

const AskUserQuestionResultView: ToolViewComponent = (props: ToolViewProps) => {
    const answers = props.block.tool.permission?.answers ?? null

    // If answers exist, AskUserQuestionView already shows them with highlighting
    // Return null to avoid duplicate display
    if (answers && Object.keys(answers).length > 0) {
        return null
    }

    // Fallback for tools without structured answers
    return <MarkdownResultView {...props} />
}

const BashResultView: ToolViewComponent = (props: ToolViewProps) => {
    const result = props.block.tool.result
    const isError = props.block.tool.state === 'error'

    if (result === undefined || result === null) {
        return <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    if (typeof result === 'string') {
        const toolUseError = parseToolUseError(result)
        const display = normalizeToolDisplayText(
            toolUseError.isToolUseError ? (toolUseError.errorMessage ?? '') : result
        )
        // Unwrap JSON-encoded content-block arrays / stdout objects before showing as code.
        const unwrapped = extractTextFromResult(display) ?? display
        return (
            <>
                <CodeBlock code={unwrapped} language="text" />
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    const stdio = extractStdoutStderr(result)
        ?? (isObject(result) && result.output !== undefined ? extractStdoutStderr(result.output) : null)
    if (stdio && (stdio.stdout || stdio.stderr)) {
        const showLabels = Boolean(stdio.stdout && stdio.stderr)
        return (
            <>
                <div className="flex flex-col gap-2 min-w-0">
                    {stdio.stdout ? (
                        showLabels
                            ? <StdioBlock label="stdout" text={stdio.stdout} />
                            : <CodeBlock code={stdio.stdout} language="text" />
                    ) : null}
                    {stdio.stderr ? (
                        showLabels
                            ? <StdioBlock label="stderr" text={stdio.stderr} tone="error" />
                            : <CodeBlock
                                code={stdio.stderr}
                                language="text"
                            />
                    ) : null}
                </div>
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    const text = extractTextFromResult(result)
    if (text) {
        return (
            <>
                <div className={isError ? 'text-red-600' : undefined}>
                    {renderText(text, { mode: 'code', language: 'text' })}
                </div>
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    return (
        <>
            <div className="text-sm text-[var(--app-hint)]">(no output)</div>
            <RawJsonDevOnly value={result} />
        </>
    )
}

const MarkdownResultView: ToolViewComponent = (props: ToolViewProps) => {
    const result = props.block.tool.result

    if (result === undefined || result === null) {
        return <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    const text = extractTextFromResult(result)
    if (text) {
        return (
            <>
                {renderText(text, { mode: 'auto' })}
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    return (
        <>
            <div className="text-sm text-[var(--app-hint)]">(no output)</div>
            <RawJsonDevOnly value={result} />
        </>
    )
}

const LineListResultView: ToolViewComponent = (props: ToolViewProps) => {
    const result = props.block.tool.result

    if (result === undefined || result === null) {
        return <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    const text = extractTextFromResult(result)
    if (!text) {
        return (
            <>
                <div className="text-sm text-[var(--app-hint)]">(no output)</div>
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    if (isProbablyMarkdownList(text)) {
        return (
            <>
                <MarkdownRenderer content={text} />
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    const lines = extractLineList(text)
    if (lines.length === 0) {
        return (
            <>
                <div className="text-sm text-[var(--app-hint)]">(no output)</div>
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    return (
        <>
            <div className="flex flex-col gap-1">
                {lines.map((line) => (
                    <div key={line} className="text-sm font-mono text-[var(--app-fg)] break-all">
                        {line}
                    </div>
                ))}
            </div>
            <RawJsonDevOnly value={result} />
        </>
    )
}

const ReadResultView: ToolViewComponent = (props: ToolViewProps) => {
    const result = props.block.tool.result

    if (result === undefined || result === null) {
        return <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    const file = extractReadFileContent(result)
    if (file) {
        const path = file.filePath ? resolveDisplayPath(file.filePath, props.metadata) : null
        return (
            <>
                {path ? (
                    <div className="mb-2 text-xs text-[var(--app-hint)] font-mono break-all">
                        {basename(path)}
                    </div>
                ) : null}
                <CodeBlock code={file.content} language="text" />
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    const text = extractTextFromResult(result)
    if (text) {
        return (
            <>
                {renderText(text, { mode: 'code', language: 'text' })}
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    return (
        <>
            <div className="text-sm text-[var(--app-hint)]">(no output)</div>
            <RawJsonDevOnly value={result} />
        </>
    )
}

const MutationResultView: ToolViewComponent = (props: ToolViewProps) => {
    const { state, result } = props.block.tool

    if (result === undefined || result === null) {
        if (state === 'completed') {
            return <div className="text-sm text-[var(--app-hint)]">Done</div>
        }
        return <div className="text-sm text-[var(--app-hint)]">{placeholderForState(state)}</div>
    }

    const text = extractTextFromResult(result)
    if (typeof text === 'string' && text.trim().length > 0) {
        const className = state === 'error' ? 'text-red-600' : 'text-[var(--app-fg)]'
        const { mode, language } = getMutationResultRenderMode(text, state)
        return (
            <>
                <div className={`text-sm ${className}`}>
                    {renderText(text, { mode, language })}
                </div>
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    return (
        <>
            <div className="text-sm text-[var(--app-hint)]">
                {state === 'completed' ? 'Done' : '(no output)'}
            </div>
            <RawJsonDevOnly value={result} />
        </>
    )
}

const CodexPatchResultView: ToolViewComponent = (props: ToolViewProps) => {
    const result = props.block.tool.result
    const text = extractTextFromResult(result)
    if (text) {
        return (
            <>
                {renderText(text, { mode: 'auto' })}
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    if (result === undefined || result === null) {
        return props.block.tool.state === 'completed'
            ? <div className="text-sm text-[var(--app-hint)]">Done</div>
            : <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    return (
        <>
            <div className="text-sm text-[var(--app-hint)]">(no output)</div>
            <RawJsonDevOnly value={result} />
        </>
    )
}

const CodexReasoningResultView: ToolViewComponent = (props: ToolViewProps) => {
    const result = props.block.tool.result
    if (result === undefined || result === null) {
        return <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    const text = extractTextFromResult(result)
    if (text) {
        return (
            <>
                {renderText(text, { mode: 'auto' })}
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    return (
        <>
            <div className="text-sm text-[var(--app-hint)]">(no output)</div>
            <RawJsonDevOnly value={result} />
        </>
    )
}

const CodexDiffResultView: ToolViewComponent = (props: ToolViewProps) => {
    const result = props.block.tool.result
    if (result === undefined || result === null) {
        return props.block.tool.state === 'completed'
            ? <div className="text-sm text-[var(--app-hint)]">Done</div>
            : <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    const text = extractTextFromResult(result)
    if (text) {
        return (
            <>
                {renderText(text, { mode: 'code', language: 'diff' })}
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    return (
        <>
            <div className="text-sm text-[var(--app-hint)]">Done</div>
            <RawJsonDevOnly value={result} />
        </>
    )
}

const TodoWriteResultView: ToolViewComponent = (props: ToolViewProps) => {
    const todos = extractTodoChecklist(props.block.tool.input, props.block.tool.result)
    if (todos.length === 0) {
        return <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    return <ChecklistList items={todos} />
}

const AgentResultView: ToolViewComponent = (props: ToolViewProps) => {
    const { state, result } = props.block.tool

    if (result === undefined || result === null) {
        return <div className="text-sm text-[var(--app-hint)]">{placeholderForState(state)}</div>
    }

    // For errors, show the error text
    if (state === 'error') {
        const text = extractTextFromResult(result)
        return (
            <div className="text-sm text-red-600 whitespace-pre-wrap break-words font-mono">
                {text?.trim() ? text : 'Agent failed'}
            </div>
        )
    }

    const text = extractTextFromResult(result)
    if (!text) {
        return <div className="text-sm text-[var(--app-hint)]">{state === 'completed' ? 'Done' : placeholderForState(state)}</div>
    }

    // Detect internal launch metadata. Check structurally first (result object
    // may carry agentId/output_file keys), then fall back to a strict text
    // pattern that is unlikely to appear in normal agent prose.
    const isInternalMeta = isObject(result) && ('agentId' in result || 'output_file' in result)
        || (text.startsWith('Async agent launched successfully.') && text.includes('agentId:'))

    if (isInternalMeta) {
        return <div className="text-sm text-[var(--app-hint)]">Agent launched</div>
    }

    return (
        <>
            <MarkdownRenderer content={text} />
            <RawJsonDevOnly value={result} />
        </>
    )
}

const SkillResultView: ToolViewComponent = (props: ToolViewProps) => {
    const { state, result, input } = props.block.tool

    if (result === undefined || result === null) {
        if (state === 'completed') {
            return <div className="text-sm text-[var(--app-hint)]">Skill loaded</div>
        }
        return <div className="text-sm text-[var(--app-hint)]">{placeholderForState(state)}</div>
    }

    // For errors, show the error text
    if (state === 'error') {
        const text = extractTextFromResult(result)
        return (
            <div className="text-sm text-red-600 whitespace-pre-wrap break-words font-mono">
                {text?.trim() ? text : 'Failed to load skill'}
            </div>
        )
    }

    // For successful loads, show just the skill name
    const skillName = getInputStringAny(input, ['skill'])
    return (
        <div className="text-sm text-[var(--app-hint)]">
            {skillName ? `Skill "${skillName}" loaded` : 'Skill loaded'}
        </div>
    )
}

const GenericResultView: ToolViewComponent = (props: ToolViewProps) => {
    const result = props.block.tool.result
    const isError = props.block.tool.state === 'error'

    if (result === undefined || result === null) {
        return <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    // Detect codex bash output format and render accordingly
    if (typeof result === 'string') {
        const parsed = parseCodexBashOutput(result)
        if (parsed) {
            return (
                <>
                    <div className="text-xs text-[var(--app-hint)] mb-2">
                        {parsed.exitCode !== null && `Exit code: ${parsed.exitCode}`}
                        {parsed.exitCode !== null && parsed.wallTime && ' · '}
                        {parsed.wallTime && `Wall time: ${parsed.wallTime}`}
                    </div>
                    {renderText(parsed.output.trim(), { mode: 'code' })}
                    <RawJsonDevOnly value={result} />
                </>
            )
        }
    }

    // Prefer structured stdout/stderr when present (common for shell-like tools).
    const stdio = extractStdoutStderr(result)
    if (stdio && (stdio.stdout || stdio.stderr)) {
        const showLabels = Boolean(stdio.stdout && stdio.stderr)
        return (
            <>
                <div className="flex flex-col gap-2 min-w-0">
                    {stdio.stdout ? (
                        showLabels
                            ? <StdioBlock label="stdout" text={stdio.stdout} />
                            : <CodeBlock code={stdio.stdout} language="text" />
                    ) : null}
                    {stdio.stderr ? (
                        showLabels
                            ? <StdioBlock label="stderr" text={stdio.stderr} tone="error" />
                            : <CodeBlock code={stdio.stderr} language="text" />
                    ) : null}
                </div>
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    const text = extractTextFromResult(result)
    if (text) {
        return (
            <>
                <div className={isError ? 'text-red-600' : undefined}>
                    {renderText(text, { mode: isError ? 'code' : 'auto', language: isError ? 'text' : undefined })}
                </div>
                {typeof result === 'object' ? <RawJsonDevOnly value={result} /> : null}
            </>
        )
    }

    if (typeof result === 'string') {
        return renderText(result, { mode: isError ? 'code' : 'auto', language: isError ? 'text' : undefined })
    }

    // Last resort: structured data. Prefer pretty JSON over a minified one-liner.
    return <CodeBlock code={safeStringify(result)} language="json" />
}

export const toolResultViewRegistry: Record<string, ToolViewComponent> = {
    Task: MarkdownResultView,
    Bash: BashResultView,
    CodexBash: BashResultView,
    Glob: LineListResultView,
    Grep: LineListResultView,
    LS: LineListResultView,
    Read: ReadResultView,
    Edit: MutationResultView,
    MultiEdit: MutationResultView,
    Write: MutationResultView,
    WebFetch: MarkdownResultView,
    WebSearch: MarkdownResultView,
    NotebookRead: ReadResultView,
    NotebookEdit: MutationResultView,
    TodoWrite: TodoWriteResultView,
    CodexReasoning: CodexReasoningResultView,
    CodexPatch: CodexPatchResultView,
    CodexDiff: CodexDiffResultView,
    Skill: SkillResultView,
    Agent: AgentResultView,
    AskUserQuestion: AskUserQuestionResultView,
    ExitPlanMode: MarkdownResultView,
    ask_user_question: AskUserQuestionResultView,
    exit_plan_mode: MarkdownResultView
}

export function getToolResultViewComponent(toolName: string, input?: unknown): ToolViewComponent {
    // Case-insensitive / Grok Execute-`cmd` aliases.
    if (isShellToolCall(toolName, input)) {
        return BashResultView
    }
    if (toolName.startsWith('mcp__')) {
        return GenericResultView
    }
    return toolResultViewRegistry[toolName] ?? GenericResultView
}
