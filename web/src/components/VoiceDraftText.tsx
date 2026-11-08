import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { useTranslation } from '@/lib/use-translation'

type Range = { start: number; end: number }
type Drag = Range & { pointerId: number; anchor: Range }

function mergeRanges(ranges: Range[]): Range[] {
    const merged: Range[] = []
    for (const range of ranges.toSorted((a, b) => a.start - b.start)) {
        const last = merged.at(-1)
        if (last && range.start <= last.end) last.end = Math.max(last.end, range.end)
        else merged.push({ start: range.start, end: range.end })
    }
    return merged
}

/** Independent touch selections; offsets use UTF-16 while hit targets preserve grapheme clusters. */
export function VoiceDraftText(props: {
    value: string
    onChange?: (text: string) => void
    onEditStart?: () => void
    onEditEnd?: () => void
    disabled?: boolean
}) {
    const { t } = useTranslation()
    const [editing, setEditing] = useState(false)
    const [selected, setSelected] = useState<Range[]>([])
    const [drag, setDrag] = useState<Drag | null>(null)
    const dragRef = useRef<Drag | null>(null)
    const endEdit = useRef(props.onEditEnd)
    endEdit.current = props.onEditEnd
    const glyphs = useMemo(() => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(props.value)], [props.value])
    useEffect(() => { setSelected([]); setDrag(null); dragRef.current = null }, [props.value])
    useEffect(() => () => endEdit.current?.(), [])

    const hit = (event: PointerEvent<HTMLDivElement>, moving: boolean): Range | null => {
        const root = event.currentTarget
        if (moving) {
            const bounds = root.getBoundingClientRect()
            if (event.clientY < bounds.top + 20) root.scrollTop -= 16
            else if (event.clientY > bounds.bottom - 20) root.scrollTop += 16
        }
        const element = moving ? document.elementFromPoint?.(event.clientX, event.clientY) ?? event.target : event.target
        const span = (element as Element | null)?.closest<HTMLElement>('[data-draft-start]')
        return span && root.contains(span) ? { start: Number(span.dataset.draftStart), end: Number(span.dataset.draftEnd) } : null
    }
    const move = (event: PointerEvent<HTMLDivElement>) => {
        const current = dragRef.current
        if (!current || current.pointerId !== event.pointerId) return
        const range = hit(event, true)
        if (!range) return
        const next = { ...current, start: Math.min(current.anchor.start, range.start), end: Math.max(current.anchor.end, range.end) }
        dragRef.current = next
        setDrag(next)
    }
    const finish = (event: PointerEvent<HTMLDivElement>) => {
        move(event)
        const current = dragRef.current
        if (!current || current.pointerId !== event.pointerId) return
        if (event.type !== 'pointercancel') setSelected(previous => mergeRanges([...previous, current]))
        else if (!selected.length) props.onEditEnd?.()
        dragRef.current = null
        setDrag(null)
    }
    const clearSelection = () => {
        setSelected([])
        setDrag(null)
        dragRef.current = null
        props.onEditEnd?.()
    }
    const ranges = drag ? [...selected, drag] : selected

    return (
        <div className="space-y-2">
            {editing ? <textarea aria-label={t('voice.omni.draft.edit')} value={props.value} rows={3} autoFocus
                disabled={props.disabled} onChange={event => props.onChange?.(event.target.value)}
                className="max-h-40 w-full resize-y select-text rounded-md border border-[var(--app-border)] bg-transparent p-2 text-sm outline-none focus:border-[var(--app-link)]" /> : props.onChange ? (
                <div role="group" aria-label={t('voice.omni.draft.text')}
                    className="max-h-40 min-h-6 touch-none select-none overflow-y-auto whitespace-pre-wrap break-words text-sm"
                    onContextMenu={event => event.preventDefault()}
                    onPointerDown={event => {
                        if (props.disabled || (event.pointerType === 'mouse' && event.button !== 0)) return
                        const range = hit(event, false)
                        if (!range) return
                        event.preventDefault()
                        props.onEditStart?.()
                        const next = { ...range, anchor: range, pointerId: event.pointerId }
                        dragRef.current = next
                        setDrag(next)
                        event.currentTarget.setPointerCapture?.(event.pointerId)
                    }}
                    onPointerMove={move} onPointerUp={finish} onPointerCancel={finish}>
                    {glyphs.map(({ segment, index }) => <span key={index} data-draft-start={index} data-draft-end={index + segment.length}
                        className={ranges.some(range => index < range.end && index + segment.length > range.start) ? 'bg-[var(--app-link)]/25' : undefined}>{segment}</span>)}
                </div>
            ) : <div className="max-h-40 overflow-y-auto whitespace-pre-wrap text-sm">{props.value}</div>}
            {props.onChange ? <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--app-hint)]">
                <button type="button" disabled={props.disabled} onClick={() => {
                    if (editing) { setEditing(false); props.onEditEnd?.() }
                    else { clearSelection(); props.onEditStart?.(); setEditing(true) }
                }}>{t(editing ? 'voice.omni.draft.doneEditing' : 'voice.omni.draft.edit')}</button>
                {!editing && selected.length ? <>
                    <button type="button" disabled={props.disabled} className="text-[var(--app-link)]" onClick={() => {
                        let text = props.value
                        for (const range of selected.toReversed()) text = text.slice(0, range.start) + text.slice(range.end)
                        props.onChange?.(text)
                        clearSelection()
                    }}>{t('voice.omni.draft.deleteSelected')}</button>
                    <button type="button" onClick={clearSelection}>{t('voice.omni.draft.clearSelection')}</button>
                </> : null}
            </div> : null}
        </div>
    )
}
