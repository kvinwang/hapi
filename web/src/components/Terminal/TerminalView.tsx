import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import type { ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { CanvasAddon } from '@xterm/addon-canvas'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import { ensureBuiltinFontLoaded, getFontProvider } from '@/lib/terminalFont'

const LIGHT_TERMINAL_THEME: ITheme = {
    background: '#ffffff',
    foreground: '#1a1a1e',
    cursor: '#1a1a1e',
    cursorAccent: '#ffffff',
    selectionBackground: 'rgba(0, 0, 0, 0.15)',
    selectionForeground: '#1a1a1e',
    black: '#1a1a1e',
    red: '#dc2626',
    green: '#16a34a',
    yellow: '#ca8a04',
    blue: '#2563eb',
    magenta: '#9333ea',
    cyan: '#0891b2',
    white: '#ffffff',
    brightBlack: '#3f3f46',
    brightRed: '#ef4444',
    brightGreen: '#22c55e',
    brightYellow: '#f59e0b',
    brightBlue: '#3b82f6',
    brightMagenta: '#a855f7',
    brightCyan: '#06b6d4',
    brightWhite: '#fafafa'
}

const DARK_TERMINAL_THEME: ITheme = {
    background: '#181B1A',
    foreground: '#fafafa',
    cursor: '#fafafa',
    cursorAccent: '#181B1A',
    selectionBackground: 'rgba(255, 255, 255, 0.2)',
    selectionForeground: '#fafafa',
    black: '#141716',
    red: '#e07070',
    green: '#5dba80',
    yellow: '#d4a44a',
    blue: '#6a9de0',
    magenta: '#b07ad0',
    cyan: '#4aabb8',
    white: '#d4d4d8',
    brightBlack: '#434645',
    brightRed: '#e89090',
    brightGreen: '#7ecf9a',
    brightYellow: '#e0be6e',
    brightBlue: '#8ab4e8',
    brightMagenta: '#c49ae0',
    brightCyan: '#6ec2cc',
    brightWhite: '#f0f0f2'
}

function resolveTheme(): ITheme {
    const isDark = document.documentElement.dataset.theme === 'dark' ||
        window.matchMedia('(prefers-color-scheme: dark)').matches
    return isDark ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME
}

export function TerminalView(props: {
    onMount?: (terminal: Terminal, search: SearchAddon) => void
    onResize?: (cols: number, rows: number) => void
    className?: string
}) {
    const containerRef = useRef<HTMLDivElement | null>(null)
    const onMountRef = useRef(props.onMount)
    const onResizeRef = useRef(props.onResize)

    useEffect(() => {
        onMountRef.current = props.onMount
    }, [props.onMount])

    useEffect(() => {
        onResizeRef.current = props.onResize
    }, [props.onResize])

    useEffect(() => {
        const container = containerRef.current
        if (!container) return

        const abortController = new AbortController()

        const fontProvider = getFontProvider()
        const terminal = new Terminal({
            cursorBlink: true,
            fontFamily: fontProvider.getFontFamily(),
            fontSize: 13,
            theme: resolveTheme(),
            convertEol: true,
            customGlyphs: true
        })

        const fitAddon = new FitAddon()
        const webLinksAddon = new WebLinksAddon()
        const canvasAddon = new CanvasAddon()
        const searchAddon = new SearchAddon()
        terminal.loadAddon(fitAddon)
        terminal.loadAddon(webLinksAddon)
        terminal.loadAddon(canvasAddon)
        terminal.loadAddon(searchAddon)
        terminal.open(container)

        // React to system theme changes.
        const themeMedia = window.matchMedia('(prefers-color-scheme: dark)')
        const updateTheme = () => {
            terminal.options.theme = resolveTheme()
        }
        themeMedia.addEventListener('change', updateTheme)

        const themeObserver = new MutationObserver(updateTheme)
        themeObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme']
        })

        const observer = new ResizeObserver(() => {
            requestAnimationFrame(() => {
                if (container.clientWidth <= 0 || container.clientHeight <= 0) {
                    return
                }
                fitAddon.fit()
                onResizeRef.current?.(terminal.cols, terminal.rows)
            })
        })
        observer.observe(container)

        const refreshFont = (forceRemeasure = false) => {
            if (abortController.signal.aborted) return
            const nextFamily = fontProvider.getFontFamily()

            if (forceRemeasure && terminal.options.fontFamily === nextFamily) {
                terminal.options.fontFamily = `${nextFamily}, "__hapi_font_refresh__"`
                requestAnimationFrame(() => {
                    if (abortController.signal.aborted) return
                    if (container.clientWidth <= 0 || container.clientHeight <= 0) {
                        return
                    }
                    terminal.options.fontFamily = nextFamily
                    if (terminal.rows > 0) {
                        terminal.refresh(0, terminal.rows - 1)
                    }
                    fitAddon.fit()
                    onResizeRef.current?.(terminal.cols, terminal.rows)
                })
                return
            }

            terminal.options.fontFamily = nextFamily
            if (terminal.rows > 0) {
                terminal.refresh(0, terminal.rows - 1)
            }
            if (container.clientWidth <= 0 || container.clientHeight <= 0) {
                return
            }
            fitAddon.fit()
            onResizeRef.current?.(terminal.cols, terminal.rows)
        }

        void ensureBuiltinFontLoaded().then(loaded => {
            if (!loaded) return
            refreshFont(true)
        })

        // Cleanup on abort
        abortController.signal.addEventListener('abort', () => {
            observer.disconnect()
            themeObserver.disconnect()
            themeMedia.removeEventListener('change', updateTheme)
            fitAddon.dispose()
            webLinksAddon.dispose()
            canvasAddon.dispose()
            searchAddon.dispose()
            terminal.dispose()
        })

        requestAnimationFrame(() => {
            if (container.clientWidth <= 0 || container.clientHeight <= 0) {
                return
            }
            fitAddon.fit()
            onResizeRef.current?.(terminal.cols, terminal.rows)
        })
        onMountRef.current?.(terminal, searchAddon)

        return () => abortController.abort()
    }, [])

    return (
        <div
            ref={containerRef}
            className={`h-full w-full ${props.className ?? ''}`}
        />
    )
}
