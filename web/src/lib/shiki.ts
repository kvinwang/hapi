import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import type { HighlighterCore } from 'shiki/core'
import { useState, useEffect, useMemo, type ReactNode } from 'react'
import { toJsxRuntime } from 'hast-util-to-jsx-runtime'
import { jsx, jsxs, Fragment } from 'react/jsx-runtime'

const MAX_HIGHLIGHT_LENGTH = 100_000

// Keep imports behind getHighlighter so chats without code do not eagerly
// request every theme and language chunk during module evaluation.
function loadThemes() {
    return [
        import('@shikijs/themes/github-light'),
        import('@shikijs/themes/github-dark'),
    ]
}

const languageLoaders: Record<string, () => Promise<unknown>> = {
    shellscript: () => import('@shikijs/langs/shellscript'),
    powershell: () => import('@shikijs/langs/powershell'),
    json: () => import('@shikijs/langs/json'),
    yaml: () => import('@shikijs/langs/yaml'),
    toml: () => import('@shikijs/langs/toml'),
    xml: () => import('@shikijs/langs/xml'),
    ini: () => import('@shikijs/langs/ini'),
    markdown: () => import('@shikijs/langs/markdown'),
    html: () => import('@shikijs/langs/html'),
    css: () => import('@shikijs/langs/css'),
    scss: () => import('@shikijs/langs/scss'),
    javascript: () => import('@shikijs/langs/javascript'),
    typescript: () => import('@shikijs/langs/typescript'),
    jsx: () => import('@shikijs/langs/jsx'),
    tsx: () => import('@shikijs/langs/tsx'),
    sql: () => import('@shikijs/langs/sql'),
    graphql: () => import('@shikijs/langs/graphql'),
    c: () => import('@shikijs/langs/c'),
    rust: () => import('@shikijs/langs/rust'),
    go: () => import('@shikijs/langs/go'),
    java: () => import('@shikijs/langs/java'),
    kotlin: () => import('@shikijs/langs/kotlin'),
    python: () => import('@shikijs/langs/python'),
    php: () => import('@shikijs/langs/php'),
    swift: () => import('@shikijs/langs/swift'),
    csharp: () => import('@shikijs/langs/csharp'),
    dockerfile: () => import('@shikijs/langs/dockerfile'),
    make: () => import('@shikijs/langs/make'),
    diff: () => import('@shikijs/langs/diff'),
}

export const SHIKI_THEMES = {
    light: 'github-light',
    dark: 'github-dark',
} as const

// Alias common code fence language names to canonical names
export const langAlias: Record<string, string> = {
    sh: 'shellscript',
    bash: 'shellscript',
    zsh: 'shellscript',
    shell: 'shellscript',
    ps1: 'powershell',
    js: 'javascript',
    ts: 'typescript',
    mjs: 'javascript',
    cjs: 'javascript',
    mts: 'typescript',
    cts: 'typescript',
    yml: 'yaml',
    md: 'markdown',
    htm: 'html',
    pgsql: 'sql',
    mysql: 'sql',
    postgres: 'sql',
    gql: 'graphql',
    py: 'python',
    rs: 'rust',
    kt: 'kotlin',
    cs: 'csharp',
    makefile: 'make',
}

// Singleton highlighter instance
let highlighterPromise: Promise<HighlighterCore> | null = null
const languageLoadPromises = new Map<string, Promise<boolean>>()

export function getHighlighter(): Promise<HighlighterCore> {
    if (!highlighterPromise) {
        highlighterPromise = createHighlighterCore({
            themes: loadThemes(),
            langs: [],
            engine: createJavaScriptRegexEngine({ forgiving: true }),
        })
    }
    return highlighterPromise
}

async function ensureLanguage(highlighter: HighlighterCore, lang: string): Promise<boolean> {
    if (highlighter.getLoadedLanguages().includes(lang)) return true
    const loader = languageLoaders[lang]
    if (!loader) return false
    let pending = languageLoadPromises.get(lang)
    if (!pending) {
        pending = loader()
            .then(async (module) => {
                await highlighter.loadLanguage(module as Parameters<HighlighterCore['loadLanguage']>[0])
                return true
            })
            .catch(() => false)
        languageLoadPromises.set(lang, pending)
    }
    return pending
}

function resolveLanguage(lang: string | undefined): string {
    if (!lang) return 'text'
    const cleaned = lang.startsWith('language-') ? lang.slice('language-'.length) : lang
    const lower = cleaned.toLowerCase().trim()
    if (lower === 'text' || lower === 'plaintext' || lower === 'txt') return 'text'
    return langAlias[lower] ?? lower
}

/**
 * Custom hook for syntax highlighting with our minimal Shiki bundle
 */
export function useShikiHighlighter(
    code: string,
    language: string | undefined
): ReactNode | null {
    const [highlighted, setHighlighted] = useState<ReactNode | null>(null)
    const lang = useMemo(() => resolveLanguage(language), [language])

    useEffect(() => {
        let cancelled = false

        if (code.length > MAX_HIGHLIGHT_LENGTH) {
            setHighlighted(null)
            return
        }

        async function highlight() {
            const highlighter = await getHighlighter()
            if (cancelled) return

            if (lang === 'text' || !(await ensureLanguage(highlighter, lang))) {
                setHighlighted(null)
                return
            }

            const hast = highlighter.codeToHast(code, {
                lang,
                themes: SHIKI_THEMES,
                defaultColor: false,
                structure: 'inline',
            })

            if (cancelled) return

            const rendered = toJsxRuntime(hast, {
                jsx,
                jsxs,
                Fragment,
            })
            setHighlighted(rendered as ReactNode)
        }

        // Debounce highlighting — 150ms reduces CPU pressure on Windows during
        // streaming where code blocks update rapidly (see #310)
        const timer = setTimeout(highlight, 150)
        return () => {
            cancelled = true
            clearTimeout(timer)
        }
    }, [code, lang])

    return highlighted
}

/**
 * Per-line syntax highlighting for the file viewer.
 * Returns an array of ReactNode (one per line) or null when unsupported.
 */
export function useShikiLineHighlighter(
    code: string,
    language: string | undefined
): ReactNode[] | null {
    const [lines, setLines] = useState<ReactNode[] | null>(null)
    const lang = useMemo(() => resolveLanguage(language), [language])

    useEffect(() => {
        let cancelled = false

        if (code.length > MAX_HIGHLIGHT_LENGTH) {
            setLines(null)
            return
        }

        async function highlight() {
            const highlighter = await getHighlighter()
            if (cancelled) return

            if (lang === 'text' || !(await ensureLanguage(highlighter, lang))) {
                setLines(null)
                return
            }

            const hast = highlighter.codeToHast(code, {
                lang,
                themes: SHIKI_THEMES,
                defaultColor: false,
                structure: 'classic',
            })

            if (cancelled) return

            // Navigate HAST: root > pre > code > span.line[]
            const pre = hast.children[0]
            if (!pre || pre.type !== 'element') { setLines(null); return }
            const codeEl = pre.children[0]
            if (!codeEl || codeEl.type !== 'element') { setLines(null); return }

            const lineNodes = codeEl.children
                .filter((child) => child.type === 'element')
                .map((lineSpan) => {
                    const lineRoot = { type: 'root' as const, children: lineSpan.children }
                    return toJsxRuntime(lineRoot, { jsx, jsxs, Fragment }) as ReactNode
                })

            setLines(lineNodes)
        }

        const timer = setTimeout(highlight, 50)
        return () => {
            cancelled = true
            clearTimeout(timer)
        }
    }, [code, lang])

    return lines
}
