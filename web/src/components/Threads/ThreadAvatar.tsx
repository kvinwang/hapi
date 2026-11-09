const badges = { session: '🤖', guest: '👤' } as const

function hash(id: string): number {
    let h = 2166136261
    for (const char of id) h = Math.imul(h ^ char.charCodeAt(0), 16777619)
    return h >>> 0
}

/** A deterministic identicon for a thread member: 15 hash bits mirror into a 5×5 grid, the rest pick its hue. */
export function ThreadAvatar({ id, kind, className = '' }: { id: string; kind: keyof typeof badges; className?: string }) {
    const h = hash(id)
    const hue = (h >>> 15) % 360
    const cells = Array.from({ length: 15 }, (_, i) => i).filter(i => h & (1 << i))
    return (
        <span className={`relative inline-block h-7 w-7 shrink-0 ${className}`} aria-hidden>
            <svg viewBox="0 0 5 5" className="h-full w-full rounded-md" style={{ background: `hsl(${hue} 60% 90%)` }} shapeRendering="crispEdges">
                {cells.flatMap(i => {
                    const x = Math.floor(i / 5), y = i % 5
                    return [...new Set([x, 4 - x])].map(cx => <rect key={`${cx}-${y}`} x={cx} y={y} width={1} height={1} fill={`hsl(${hue} 55% 45%)`} />)
                })}
            </svg>
            <span className="absolute -bottom-1 -right-1 rounded-full bg-[var(--app-bg)] text-[9px] leading-none">{badges[kind]}</span>
        </span>
    )
}
