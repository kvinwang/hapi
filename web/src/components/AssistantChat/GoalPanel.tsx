import { useEffect, useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'

type Goal = {
    objective: string
    status: 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete'
    tokenBudget: number | null
    tokensUsed: number | null
    timeUsedSeconds: number
}

const STATUSES: Goal['status'][] = ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']

function number(value: number): string {
    return new Intl.NumberFormat().format(value)
}

export function GoalPanel(props: { api: ApiClient; sessionId: string; goal: Goal | null | undefined; active: boolean }) {
    const [open, setOpen] = useState(false)
    const [editing, setEditing] = useState(false)
    const [objective, setObjective] = useState(props.goal?.objective ?? '')
    const [budget, setBudget] = useState(props.goal?.tokenBudget?.toString() ?? '')
    const [status, setStatus] = useState<Goal['status']>(props.goal?.status ?? 'active')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const triggerRef = useRef<HTMLButtonElement>(null)
    const panelRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (editing) return
        setObjective(props.goal?.objective ?? '')
        setBudget(props.goal?.tokenBudget?.toString() ?? '')
        setStatus(props.goal?.status ?? 'active')
    }, [props.goal, editing])

    useEffect(() => {
        if (!open) return
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target
            if (!(target instanceof Node)) return
            if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return
            setOpen(false)
            setEditing(false)
        }
        document.addEventListener('pointerdown', closeOnOutsidePointer)
        return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
    }, [open])

    const save = async () => {
        if (!objective.trim()) return
        setBusy(true); setError(null)
        try {
            await props.api.setGoal(props.sessionId, {
                objective: objective.trim(), status,
                tokenBudget: budget.trim() ? Number(budget) : null
            })
            setOpen(false)
            setEditing(false)
        } catch (e) { setError(e instanceof Error ? e.message : 'Failed to update goal') }
        finally { setBusy(false) }
    }

    const clear = async () => {
        setBusy(true); setError(null)
        try { await props.api.clearGoal(props.sessionId); setOpen(false); setEditing(false) }
        catch (e) { setError(e instanceof Error ? e.message : 'Failed to clear goal') }
        finally { setBusy(false) }
    }

    return <div className="relative px-2 pb-1 text-xs">
        <button ref={triggerRef} type="button" onClick={() => {
            setOpen(value => {
                const next = !value
                if (next && !props.goal) setEditing(true)
                if (!next) setEditing(false)
                return next
            })
        }} className="flex max-w-full items-center gap-2 text-left text-[var(--app-hint)] hover:text-[var(--app-fg)]">
            <span>◎</span>
            <span className="truncate">{props.goal?.objective ?? 'Set goal'}</span>
            {props.goal ? <span className="shrink-0 opacity-70">{props.goal.status}{props.goal.tokensUsed !== null ? ` · ${number(props.goal.tokensUsed)} tokens` : ''}{props.goal.tokenBudget ? ` / ${number(props.goal.tokenBudget)}` : ''}</span> : null}
        </button>
        {open ? <div ref={panelRef} className="absolute bottom-full left-2 right-2 z-30 mb-2 space-y-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3 shadow-xl">
            {!editing && props.goal ? <>
                <div className="whitespace-pre-wrap text-sm text-[var(--app-fg)]">{props.goal.objective}</div>
                <div className="text-[var(--app-hint)]">{props.goal.status}{props.goal.tokenBudget ? ` · ${number(props.goal.tokenBudget)} token budget` : ''}</div>
                <div className="flex justify-between">
                    <button type="button" disabled={busy || !props.active} onClick={() => void clear()} className="text-red-500 disabled:opacity-40">Clear</button>
                    <button type="button" disabled={busy || !props.active} onClick={() => setEditing(true)} className="rounded bg-[var(--app-link)] px-3 py-1.5 text-white disabled:opacity-40">Edit</button>
                </div>
            </> : <>
            <textarea value={objective} onChange={e => setObjective(e.target.value)} rows={3} placeholder="Goal objective" className="w-full resize-none rounded border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-2 text-[var(--app-fg)]" />
            <div className="flex gap-2">
                <select value={status} onChange={e => setStatus(e.target.value as Goal['status'])} className="min-w-0 flex-1 rounded border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-2">
                    {STATUSES.map(value => <option key={value} value={value}>{value}</option>)}
                </select>
                <input value={budget} onChange={e => setBudget(e.target.value)} type="number" min="1" placeholder="Token budget" className="min-w-0 flex-1 rounded border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-2" />
            </div>
            {error ? <div className="text-red-500">{error}</div> : null}
            <div className="flex justify-between">
                <button type="button" disabled={busy} onClick={() => props.goal ? setEditing(false) : setOpen(false)} className="text-[var(--app-hint)] disabled:opacity-40">Cancel</button>
                <button type="button" disabled={busy || !props.active || !objective.trim() || (budget !== '' && Number(budget) <= 0)} onClick={() => void save()} className="rounded bg-[var(--app-link)] px-3 py-1.5 text-white disabled:opacity-40">Save</button>
            </div>
            </>}
        </div> : null}
    </div>
}
