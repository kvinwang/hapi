import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const STORAGE_KEY = 'hapi:performance-monitor'
const REPORT_STORAGE_KEY = 'hapi:performance-report'
const POSITION_STORAGE_KEY = 'hapi:performance-monitor-position'
const CHAT_PERF_STORAGE_KEY = 'hapi.chatPerf'
const SAMPLE_INTERVAL_MS = 5_000
const FRAME_BURST_MS = 500

interface ReactCommitStats {
    count: number
    totalMs: number
    maxMs: number
}

interface Snapshot {
    atMs: number
    view: string
    fps: number
    p95FrameMs: number
    maxFrameMs: number
    longFrames: number
    longTasks: number
    longTaskMs: number
    eventLoopLagMs: number
    reactCommits: number
    reactCommitMs: number
    maxReactCommitMs: number
    domNodes: number
    mutations: number
    addedNodes: number
    removedNodes: number
    addedElements: number
    addedMarkdownElements: number
    addedToolElements: number
    runningAnimations: number
    animationNames: string[]
    canvases: number
    backdropFilters: number
}

const reactCommitStats: ReactCommitStats = { count: 0, totalMs: 0, maxMs: 0 }
const capturedSamples: Snapshot[] = []

function currentView(): string {
    const path = window.location.pathname
    if (/^\/sessions\/[^/]+\/terminal/.test(path)) return 'session-terminal'
    if (/^\/sessions\/[^/]+\/(files|file)/.test(path)) return 'session-files'
    if (/^\/sessions\/[^/]+/.test(path)) return 'session-chat'
    if (path.startsWith('/sessions')) return 'sessions'
    if (path.startsWith('/settings')) return 'settings'
    return 'other'
}

function createReport(): Record<string, unknown> {
    if (capturedSamples.length === 0) {
        try {
            const archived = sessionStorage.getItem(REPORT_STORAGE_KEY)
            if (archived) return JSON.parse(archived) as Record<string, unknown>
        } catch { /* ignore unavailable or corrupted storage */ }
    }
    return {
        schemaVersion: 2,
        generatedAt: new Date().toISOString(),
        viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
        standalone: window.matchMedia('(display-mode: standalone)').matches,
        visibility: document.visibilityState,
        sampleIntervalMs: SAMPLE_INTERVAL_MS,
        frameBurstMs: FRAME_BURST_MS,
        samples: capturedSamples,
        chatStages: window.__HAPI_CHAT_PERF__?.snapshot() ?? {},
    }
}

export function isPerformanceMonitorEnabled(): boolean {
    const requested = new URLSearchParams(window.location.search).get('perf')
    if (requested === '0') {
        localStorage.removeItem(STORAGE_KEY)
        localStorage.removeItem(CHAT_PERF_STORAGE_KEY)
        return false
    }
    if (requested === '1') {
        localStorage.setItem(STORAGE_KEY, '1')
        localStorage.setItem(CHAT_PERF_STORAGE_KEY, '1')
        return true
    }
    return localStorage.getItem(STORAGE_KEY) === '1'
}

export function setPerformanceMonitorEnabled(enabled: boolean): void {
    if (enabled) {
        localStorage.setItem(STORAGE_KEY, '1')
        localStorage.setItem(CHAT_PERF_STORAGE_KEY, '1')
        sessionStorage.removeItem(REPORT_STORAGE_KEY)
        capturedSamples.length = 0
        window.__HAPI_CHAT_PERF__?.reset()
        return
    }
    if (capturedSamples.length > 0) {
        sessionStorage.setItem(REPORT_STORAGE_KEY, JSON.stringify(createReport()))
    }
    localStorage.removeItem(STORAGE_KEY)
    localStorage.removeItem(CHAT_PERF_STORAGE_KEY)
}

export function isPerformanceReportAvailable(): boolean {
    if (isPerformanceMonitorEnabled() || capturedSamples.length > 0) return true
    try {
        return sessionStorage.getItem(REPORT_STORAGE_KEY) !== null
    } catch {
        return false
    }
}

export function createPerformanceReportFile(): File {
    const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
    return new File(
        [JSON.stringify(createReport(), null, 2)],
        `hapi-performance-${timestamp}.json`,
        { type: 'application/json' },
    )
}

export function recordReactCommit(
    _id: string,
    _phase: 'mount' | 'update' | 'nested-update',
    actualDuration: number,
): void {
    reactCommitStats.count += 1
    reactCommitStats.totalMs += actualDuration
    reactCommitStats.maxMs = Math.max(reactCommitStats.maxMs, actualDuration)
}

const EMPTY_SNAPSHOT: Snapshot = {
    atMs: 0,
    view: 'other',
    fps: 0,
    p95FrameMs: 0,
    maxFrameMs: 0,
    longFrames: 0,
    longTasks: 0,
    longTaskMs: 0,
    eventLoopLagMs: 0,
    reactCommits: 0,
    reactCommitMs: 0,
    maxReactCommitMs: 0,
    domNodes: 0,
    mutations: 0,
    addedNodes: 0,
    removedNodes: 0,
    addedElements: 0,
    addedMarkdownElements: 0,
    addedToolElements: 0,
    runningAnimations: 0,
    animationNames: [],
    canvases: 0,
    backdropFilters: 0,
}

function round(value: number): number {
    return Math.round(value * 10) / 10
}

function readPosition(): { x: number; y: number } {
    try {
        const value = JSON.parse(localStorage.getItem(POSITION_STORAGE_KEY) ?? '')
        if (Number.isFinite(value?.x) && Number.isFinite(value?.y)) return value
    } catch { /* use default */ }
    return { x: Math.max(8, window.innerWidth - 76), y: Math.max(8, window.innerHeight - 48) }
}

export function PerformanceMonitor() {
    const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY_SNAPSHOT)
    const [collapsed, setCollapsed] = useState(true)
    const [position, setPosition] = useState(readPosition)
    const dragRef = useRef<{
        pointerId: number
        dx: number
        dy: number
        startX: number
        startY: number
        moved: boolean
    } | null>(null)
    const suppressClickRef = useRef(false)
    const positionRef = useRef(position)

    useEffect(() => {
        positionRef.current = position
    }, [position])

    useEffect(() => {
        let frame = 0
        let collectTimer = 0
        let publishTimer = 0
        let lagTimer = 0
        let expectedTimerAt = performance.now() + 250
        let maxEventLoopLag = 0
        let longTasks = 0
        let longTaskMs = 0
        let mutations = 0
        let addedNodes = 0
        let removedNodes = 0
        let addedElements = 0
        let addedMarkdownElements = 0
        let addedToolElements = 0
        const startedAt = performance.now()

        const longTaskObserver = typeof PerformanceObserver !== 'undefined'
            && PerformanceObserver.supportedEntryTypes?.includes('longtask')
            ? new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    longTasks += 1
                    longTaskMs += entry.duration
                }
            })
            : null
        longTaskObserver?.observe({ entryTypes: ['longtask'] })

        const mutationObserver = new MutationObserver((records) => {
            for (const record of records) {
                const target = record.target instanceof Element ? record.target : record.target.parentElement
                if (target?.closest('[data-performance-monitor]')) continue
                mutations += 1
                addedNodes += record.addedNodes.length
                removedNodes += record.removedNodes.length
                for (const node of record.addedNodes) {
                    if (!(node instanceof Element)) continue
                    const descendants = node.querySelectorAll('*')
                    addedElements += 1 + descendants.length
                    addedMarkdownElements += (node.matches('.aui-md, .aui-md *') ? 1 : 0)
                        + node.querySelectorAll('.aui-md, .aui-md *').length
                    addedToolElements += (node.matches('[data-tool-group], [data-tool-group] *') ? 1 : 0)
                        + node.querySelectorAll('[data-tool-group], [data-tool-group] *').length
                }
            }
        })
        mutationObserver.observe(document.body, { childList: true, subtree: true, characterData: true })

        lagTimer = window.setInterval(() => {
            const now = performance.now()
            maxEventLoopLag = Math.max(maxEventLoopLag, now - expectedTimerAt)
            expectedTimerAt = now + 250
        }, 250)

        const collect = () => {
            const burstStartedAt = performance.now()
            let lastFrameAt = burstStartedAt
            let frames = 0
            const frameDurations: number[] = []

            const tick = (now: number) => {
                const duration = now - lastFrameAt
                lastFrameAt = now
                frames += 1
                if (duration < 1000) frameDurations.push(duration)
                if (now - burstStartedAt < FRAME_BURST_MS) {
                    frame = requestAnimationFrame(tick)
                    return
                }

                const sortedFrames = [...frameDurations].sort((a, b) => a - b)
                const p95Index = Math.max(0, Math.ceil(sortedFrames.length * 0.95) - 1)
                const animations = document.getAnimations?.().filter((animation) => animation.playState === 'running') ?? []
                const animationNames = [...new Set(animations.map((animation) => {
                    const effect = animation.effect as KeyframeEffect | null
                    return effect?.target instanceof Element
                        ? getComputedStyle(effect.target).animationName
                        : 'unknown'
                }).filter((name) => name && name !== 'none'))]
                const allElements = document.getElementsByTagName('*')
                let backdropFilters = 0
                for (const element of document.querySelectorAll('[class*="backdrop"]')) {
                    const style = getComputedStyle(element)
                    if (style.backdropFilter && style.backdropFilter !== 'none') backdropFilters += 1
                }
                const next: Snapshot = {
                    atMs: Math.round(performance.now() - startedAt),
                    view: currentView(),
                    fps: round(frames * 1000 / Math.max(1, lastFrameAt - burstStartedAt)),
                    p95FrameMs: round(sortedFrames[p95Index] ?? 0),
                    maxFrameMs: round(sortedFrames.at(-1) ?? 0),
                    longFrames: frameDurations.filter((duration) => duration > 50).length,
                    longTasks,
                    longTaskMs: round(longTaskMs),
                    eventLoopLagMs: round(maxEventLoopLag),
                    reactCommits: reactCommitStats.count,
                    reactCommitMs: round(reactCommitStats.totalMs),
                    maxReactCommitMs: round(reactCommitStats.maxMs),
                    domNodes: allElements.length,
                    mutations,
                    addedNodes,
                    removedNodes,
                    addedElements,
                    addedMarkdownElements,
                    addedToolElements,
                    runningAnimations: animations.length,
                    animationNames,
                    canvases: document.querySelectorAll('canvas').length,
                    backdropFilters,
                }
                capturedSamples.push(next)
                if (capturedSamples.length > 120) capturedSamples.shift()
                setSnapshot(next)

                longTasks = 0
                longTaskMs = 0
                maxEventLoopLag = 0
                mutations = 0
                addedNodes = 0
                removedNodes = 0
                addedElements = 0
                addedMarkdownElements = 0
                addedToolElements = 0
                reactCommitStats.count = 0
                reactCommitStats.totalMs = 0
                reactCommitStats.maxMs = 0
                publishTimer = window.setTimeout(collect, SAMPLE_INTERVAL_MS - FRAME_BURST_MS)
            }
            frame = requestAnimationFrame(tick)
        }
        collectTimer = window.setTimeout(collect, 250)

        return () => {
            cancelAnimationFrame(frame)
            clearTimeout(collectTimer)
            clearTimeout(publishTimer)
            clearInterval(lagTimer)
            longTaskObserver?.disconnect()
            mutationObserver.disconnect()
        }
    }, [])

    const clampPosition = useCallback((x: number, y: number) => ({
        x: Math.min(Math.max(8, x), Math.max(8, window.innerWidth - (collapsed ? 68 : 160))),
        y: Math.min(Math.max(8, y), Math.max(8, window.innerHeight - (collapsed ? 36 : 310))),
    }), [collapsed])

    useEffect(() => {
        const move = (event: PointerEvent) => {
            const drag = dragRef.current
            if (!drag || drag.pointerId !== event.pointerId) return
            if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) return
            drag.moved = true
            setPosition(clampPosition(event.clientX - drag.dx, event.clientY - drag.dy))
        }
        const stop = (event: PointerEvent) => {
            const drag = dragRef.current
            if (!drag || drag.pointerId !== event.pointerId) return
            suppressClickRef.current = drag.moved
            dragRef.current = null
            localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(positionRef.current))
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', stop)
        window.addEventListener('pointercancel', stop)
        return () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', stop)
            window.removeEventListener('pointercancel', stop)
        }
    }, [clampPosition])

    useEffect(() => {
        const keepVisible = () => setPosition((current) => clampPosition(current.x, current.y))
        keepVisible()
        window.addEventListener('resize', keepVisible)
        return () => window.removeEventListener('resize', keepVisible)
    }, [clampPosition])

    const startDrag = (event: React.PointerEvent<HTMLElement>) => {
        const rect = event.currentTarget.getBoundingClientRect()
        dragRef.current = {
            pointerId: event.pointerId,
            dx: event.clientX - rect.left,
            dy: event.clientY - rect.top,
            startX: event.clientX,
            startY: event.clientY,
            moved: false,
        }
        event.currentTarget.setPointerCapture(event.pointerId)
    }

    const toggleCollapsed = () => {
        if (suppressClickRef.current) {
            suppressClickRef.current = false
            return
        }
        setCollapsed((value) => !value)
    }

    const disable = () => {
        setPerformanceMonitorEnabled(false)
        window.location.reload()
    }

    if (collapsed) {
        return createPortal(
            <button
                type="button"
                data-performance-monitor
                onPointerDown={startDrag}
                onClick={toggleCollapsed}
                style={{ left: position.x, top: position.y }}
                className="fixed z-[100] cursor-move touch-none rounded bg-black/80 px-2 py-1 font-mono text-xs text-white shadow-lg"
            >
                PERF {snapshot.fps}
            </button>,
            document.body,
        )
    }

    return createPortal(
        <aside data-performance-monitor style={{ left: position.x, top: position.y }} className="fixed z-[100] w-[152px] overflow-hidden rounded-md bg-black/90 font-mono text-[10px] tabular-nums text-white shadow-xl">
            <div onPointerDown={startDrag} className="flex h-9 cursor-move touch-none items-center justify-between border-b border-white/15 pl-2 pr-1 font-semibold">
                <span className="truncate">Performance</span>
                <button
                    type="button"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={toggleCollapsed}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-white/70 hover:bg-white/15 hover:text-white active:bg-white/25"
                    aria-label="Collapse performance monitor"
                    title="Collapse"
                >
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                        <path d="M3 8h10" />
                    </svg>
                </button>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-1 gap-y-0.5 whitespace-nowrap px-2 py-1.5 leading-4">
                <span className="truncate text-white/55">View</span><span className="max-w-20 truncate text-right">{snapshot.view}</span>
                <span className="text-white/55">FPS</span><span className="text-right">{snapshot.fps}</span>
                <span className="text-white/55">p95 / max</span><span className="text-right">{snapshot.p95FrameMs}/{snapshot.maxFrameMs}</span>
                <span className="text-white/55">Loop lag</span><span className="text-right">{snapshot.eventLoopLagMs} ms</span>
                <span className="text-white/55">DOM</span><span className="text-right">{snapshot.domNodes}</span>
                <span className="text-white/55">Mutations</span><span className="text-right">{snapshot.mutations}</span>
                <span className="text-white/55">Elements</span><span className="text-right">+{snapshot.addedElements}</span>
                <span className="text-white/55">Markdown</span><span className="text-right">+{snapshot.addedMarkdownElements}</span>
                <span className="text-white/55">Tools +</span><span className="text-right">{snapshot.addedToolElements}</span>
            </div>
            <div className="border-t border-white/15 p-2">
                <button
                    type="button"
                    onClick={disable}
                    className="flex h-9 w-full items-center justify-center gap-1.5 rounded border border-red-400/25 bg-red-500/15 font-sans text-xs font-medium text-red-200 hover:bg-red-500/25 active:bg-red-500/35"
                    aria-label="Stop performance collection"
                >
                    <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" aria-hidden="true">
                        <rect x="3" y="3" width="10" height="10" rx="1" />
                    </svg>
                    <span>Stop collection</span>
                </button>
            </div>
        </aside>,
        document.body,
    )
}
