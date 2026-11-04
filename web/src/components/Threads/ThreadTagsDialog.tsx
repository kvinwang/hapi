import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ThreadTagsSchema, type Thread } from '@hapi/protocol/threads'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { ThreadTags } from './ThreadTags'
import { threadButton, threadInput } from './types'

export function ThreadTagsDialog({ thread, onClose }: { thread: Thread; onClose: () => void }) {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const client = useQueryClient()
    const [tags, setTags] = useState(thread.tags)
    const [input, setInput] = useState('')
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState('')
    const updatedTags = () => {
        const tag = input.trim()
        const parsed = ThreadTagsSchema.safeParse(tag ? [...new Set([...tags, tag])] : tags)
        if (!parsed.success) {
            setError('Use up to 20 tags, with at most 255 characters each.')
            return null
        }
        setError('')
        return parsed.data
    }
    const add = () => {
        const next = updatedTags()
        if (!next) return
        setTags(next)
        setInput('')
    }
    return (
        <Dialog open onOpenChange={open => { if (!open && !saving) onClose() }}>
            <DialogContent>
                <DialogTitle>{t('dialog.properties.tags')}</DialogTitle>
                <DialogDescription>{thread.name}</DialogDescription>
                <form className="mt-4 space-y-4" onSubmit={event => {
                    event.preventDefault()
                    if (saving) return
                    const next = updatedTags()
                    if (!next) return
                    setSaving(true)
                    setError('')
                    void api.threadRequest(`/${thread.id}/tags`, { tags: next })
                        .then(async () => {
                            await client.invalidateQueries({ queryKey: ['threads'] })
                            onClose()
                        })
                        .catch(error => setError(error instanceof Error ? error.message : String(error)))
                        .finally(() => setSaving(false))
                }}>
                    <fieldset disabled={saving} className="space-y-3">
                        <div className="flex items-center gap-2">
                            <input autoFocus aria-label={t('dialog.properties.addTag')} placeholder={t('dialog.properties.addTag')} className={threadInput} maxLength={255} value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => {
                                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                                    event.preventDefault()
                                    add()
                                }
                            }} />
                            <button type="button" className={threadButton} disabled={!input.trim()} onClick={add} aria-label="Add tag">＋</button>
                        </div>
                        <ThreadTags tags={tags} onRemove={tag => setTags(tags.filter(value => value !== tag))} />
                    </fieldset>
                    {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
                    <div className="flex justify-end gap-2">
                        <button type="button" className={threadButton} disabled={saving} onClick={onClose}>{t('button.cancel')}</button>
                        <button type="submit" className={threadButton} disabled={saving}>{t('button.save')}</button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    )
}
