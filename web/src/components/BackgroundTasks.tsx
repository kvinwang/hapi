import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { BackgroundTask } from '@hapi/protocol/types'
import type { ApiClient } from '@/api/client'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useTranslation } from '@/lib/use-translation'
import { formatElapsedDuration } from '@/lib/utils'

export function BackgroundTasks(props: {
    tasks: Record<string, BackgroundTask>
    sessionId: string
    host: string
    active: boolean
    api: ApiClient | null
}) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)
    const [selected, setSelected] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [now, setNow] = useState(Date.now())
    const tasks = Object.values(props.tasks).sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt - a.startedAt)
    const running = props.active ? tasks.filter(task => task.status === 'running').length : 0
    const task = selected ? props.tasks[selected] : undefined
    const output = useQuery({
        queryKey: ['background-task-output', props.sessionId, selected, task?.status],
        queryFn: () => props.api!.getTaskOutput(props.sessionId, selected!),
        enabled: open && Boolean(selected && props.api && props.active),
        refetchInterval: task?.status === 'running' && props.active ? 3000 : false
    })
    useEffect(() => {
        if (!open || !running) return
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
    }, [open, running])
    if (!tasks.length) return null

    const stop = async () => {
        if (!task || !props.api || !window.confirm(t('tasks.confirmStop'))) return
        setBusy(true)
        setError(null)
        try {
            await props.api.stopTask(props.sessionId, task.id)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setBusy(false)
        }
    }

    return <>
        <button type="button" onClick={() => setOpen(true)} className="ml-2 rounded-full bg-[var(--app-secondary-bg)] px-2 py-0.5 text-[var(--app-hint)] hover:text-[var(--app-link)]">
            {t('tasks.chip', { count: tasks.length })}{running ? ` · ${t('subagent.chip.running', { count: running })}` : ''}
        </button>
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent className="max-h-[85dvh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{t('tasks.chip', { count: tasks.length })}</DialogTitle>
                    <DialogDescription>{t('tasks.description', { host: props.host })}</DialogDescription>
                </DialogHeader>
                <div className="space-y-2">
                    {tasks.map(entry => {
                        const status = entry.status === 'running' && !props.active ? 'unknown' : entry.status
                        return <button key={entry.id} type="button" onClick={() => { setSelected(entry.id); setError(null) }} aria-pressed={selected === entry.id}
                            className="block w-full rounded-md border border-[var(--app-border)] p-2 text-left hover:bg-[var(--app-secondary-bg)]">
                            <div className="break-words text-sm">{entry.description}</div>
                            <div className="text-xs text-[var(--app-hint)]">
                                {t(`tasks.status.${status}`)} · {entry.id}
                                {entry.finishedAt || status === 'running' ? ` · ${formatElapsedDuration(Math.max(0, (entry.finishedAt ?? now) - entry.startedAt) / 1000)}` : ''}
                                {entry.parentToolUseId ? ` · Agent ${entry.parentToolUseId}` : ''}
                            </div>
                        </button>
                    })}
                </div>
                {task ? <div className="min-w-0 space-y-2">
                    {task.command ? <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all text-xs">{task.command}</pre> : null}
                    {task.outputFile ? <div className="break-all text-xs text-[var(--app-hint)]">{task.outputFile}</div> : null}
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--app-secondary-bg)] p-2 text-xs">{output.data?.output || task.summary || t('tasks.noOutput')}</pre>
                    {output.error || error ? <div role="alert" className="text-xs text-red-500">{error ?? output.error?.message}</div> : null}
                    {task.status === 'running' && props.active && props.api ? <button type="button" disabled={busy} onClick={() => void stop()} className="rounded border border-[var(--app-border)] px-3 py-1 text-sm text-red-500 disabled:opacity-50">{t('tasks.stop')}</button> : null}
                </div> : null}
                <button type="button" onClick={() => setOpen(false)} className="justify-self-end rounded border border-[var(--app-border)] px-3 py-1 text-sm">{t('button.close')}</button>
            </DialogContent>
        </Dialog>
    </>
}
