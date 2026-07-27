import { useEffect, useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { GoalHistoryEntry } from '@/types/api'

type Goal = {
    objective: string
    status: 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete'
    tokenBudget: number | null
    tokensUsed: number | null
    timeUsedSeconds: number
}

const STATUSES: Goal['status'][] = ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']

const DEFAULT_REMINDER_INTERVAL_MINUTES = 15
const DEFAULT_REMINDER_HOURS = 2

function number(value: number): string {
    return new Intl.NumberFormat().format(value)
}

function summarize(objective: string): string {
    const line = objective.trim().split('\n')[0] ?? ''
    return line.length > 80 ? `${line.slice(0, 80)}…` : line
}

/**
 * Builds a "keep reminding me" objective: the agent finishes the task at hand, then pings
 * on a fixed interval until the deadline instead of ending the session.
 */
export function buildReminderObjective(intervalMinutes: number, hours: number, now: number = Date.now()): string {
    const until = new Date(now + hours * 3600_000)
    return [
        'Do not stop when the current task is done — stay on as a reminder loop.',
        '',
        '1. Finish the task in progress first and report the result as usual.',
        `2. After that, send me a short reminder message every ${intervalMinutes} minutes: what is done, what is still pending, and how much time is left.`,
        `3. Between reminders, wait out the full ${intervalMinutes} minutes with real sleeps (split into chunks of 5 minutes or less if your shell caps command timeouts) instead of ending your turn or spinning on busy work.`,
        `4. Keep this up until ${until.toISOString()} (${until.toLocaleString()}, ${hours} hour(s) from now), then send a final wrap-up message and mark this goal complete.`,
        '5. If I reply in the meantime, handle my message first, then resume the reminder loop.'
    ].join('\n')
}

export function GoalPanel(props: { api: ApiClient; sessionId: string; goal: Goal | null | undefined; active: boolean }) {
    const [open, setOpen] = useState(false)
    const [editing, setEditing] = useState(false)
    const [objective, setObjective] = useState(props.goal?.objective ?? '')
    const [budget, setBudget] = useState(props.goal?.tokenBudget?.toString() ?? '')
    const [status, setStatus] = useState<Goal['status']>(props.goal?.status ?? 'active')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [history, setHistory] = useState<GoalHistoryEntry[]>([])
    const [historyLoaded, setHistoryLoaded] = useState(false)
    const [reminderInterval, setReminderInterval] = useState(String(DEFAULT_REMINDER_INTERVAL_MINUTES))
    const [reminderHours, setReminderHours] = useState(String(DEFAULT_REMINDER_HOURS))
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

    useEffect(() => {
        if (!open || !editing || historyLoaded) return
        let cancelled = false
        void props.api.listGoalHistory()
            .then(response => { if (!cancelled) { setHistory(response.goals); setHistoryLoaded(true) } })
            .catch(() => { if (!cancelled) setHistoryLoaded(true) })
        return () => { cancelled = true }
    }, [open, editing, historyLoaded, props.api])

    const setReminderGoal = async () => {
        const minutes = Number(reminderInterval) || DEFAULT_REMINDER_INTERVAL_MINUTES
        const hours = Number(reminderHours) || DEFAULT_REMINDER_HOURS
        const text = buildReminderObjective(minutes, hours)
        setObjective(text)
        setStatus('active')
        await save({ objective: text, status: 'active' })
    }

    const save = async (override?: { objective: string; status: Goal['status'] }) => {
        const text = (override?.objective ?? objective).trim()
        if (!text) return
        setBusy(true); setError(null)
        try {
            await props.api.setGoal(props.sessionId, {
                objective: text, status: override?.status ?? status,
                tokenBudget: budget.trim() ? Number(budget) : null
            })
            setOpen(false)
            setEditing(false)
            setHistoryLoaded(false)
        } catch (e) { setError(e instanceof Error ? e.message : 'Failed to update goal') }
        finally { setBusy(false) }
    }

    const historyMatch = history.find(entry => entry.objective === objective.trim()) ?? null

    const forgetHistoryEntry = async (target: string) => {
        setHistory(entries => entries.filter(entry => entry.objective !== target))
        await props.api.deleteGoalHistory(target).catch(() => setHistoryLoaded(false))
    }

    const clear = async () => {
        setBusy(true); setError(null)
        try { await props.api.clearGoal(props.sessionId); setOpen(false); setEditing(false) }
        catch (e) { setError(e instanceof Error ? e.message : 'Failed to clear goal') }
        finally { setBusy(false) }
    }

    // Status-only toggle: leaves the objective and budget untouched so the agent keeps its progress.
    const toggleActive = async () => {
        const next: Goal['status'] = props.goal?.status === 'active' ? 'paused' : 'active'
        setBusy(true); setError(null)
        try { await props.api.setGoal(props.sessionId, { status: next }) }
        catch (e) { setError(e instanceof Error ? e.message : 'Failed to update goal') }
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
                {error ? <div className="text-red-500">{error}</div> : null}
                <div className="flex items-center justify-between gap-2">
                    <button type="button" disabled={busy || !props.active} onClick={() => void clear()} className="text-red-500 disabled:opacity-40">Clear</button>
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            disabled={busy || !props.active}
                            title={props.goal.status === 'active' ? 'Pause the goal so the session can stop' : 'Resume the goal and keep working on it'}
                            onClick={() => void toggleActive()}
                            className="rounded border border-[var(--app-border)] px-3 py-1.5 text-[var(--app-fg)] disabled:opacity-40"
                        >{props.goal.status === 'active' ? '⏸ Pause' : '▶ Resume'}</button>
                        <button type="button" disabled={busy || !props.active} onClick={() => setEditing(true)} className="rounded bg-[var(--app-link)] px-3 py-1.5 text-white disabled:opacity-40">Edit</button>
                    </div>
                </div>
            </> : <>
            <div className="flex items-center gap-1.5">
                <select
                    value=""
                    disabled={history.length === 0}
                    aria-label="Recent goals"
                    onChange={e => {
                        const entry = history.find(item => item.objective === e.target.value)
                        if (!entry) return
                        setObjective(entry.objective)
                        setBudget(entry.tokenBudget?.toString() ?? '')
                    }}
                    className="min-w-0 flex-1 rounded border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-1.5 disabled:opacity-40"
                >
                    <option value="">{history.length ? 'Reuse a recent goal…' : historyLoaded ? 'No recent goals' : 'Loading recent goals…'}</option>
                    {history.map(entry => <option key={entry.objective} value={entry.objective}>{summarize(entry.objective)}</option>)}
                </select>
                {historyMatch ? <button
                    type="button"
                    disabled={busy}
                    title="Remove from recent goals"
                    aria-label="Remove from recent goals"
                    onClick={() => void forgetHistoryEntry(historyMatch.objective)}
                    className="shrink-0 rounded border border-[var(--app-border)] px-2 py-1.5 text-[var(--app-hint)] hover:text-red-500 disabled:opacity-40"
                >✕</button> : null}
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-[var(--app-hint)]">
                <button
                    type="button"
                    disabled={busy || !props.active}
                    title="Set a goal that keeps this session alive and pings you on an interval instead of exiting"
                    onClick={() => void setReminderGoal()}
                    className="shrink-0 rounded border border-[var(--app-border)] px-2 py-1 text-[var(--app-fg)] disabled:opacity-40"
                >⏰ Remind me</button>
                <span>every</span>
                <input value={reminderInterval} onChange={e => setReminderInterval(e.target.value)} type="number" min="1" aria-label="Reminder interval in minutes" className="w-14 rounded border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-1 text-center text-[var(--app-fg)]" />
                <span>min for</span>
                <input value={reminderHours} onChange={e => setReminderHours(e.target.value)} type="number" min="1" step="0.5" aria-label="Reminder duration in hours" className="w-14 rounded border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-1 text-center text-[var(--app-fg)]" />
                <span>h</span>
            </div>
            <textarea value={objective} onChange={e => setObjective(e.target.value)} rows={7} placeholder="Goal objective" className="w-full min-h-36 resize-y rounded border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-2 text-[var(--app-fg)]" />
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
