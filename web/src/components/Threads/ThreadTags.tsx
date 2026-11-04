export function ThreadTags({ tags, onRemove }: { tags: string[]; onRemove?: (tag: string) => void }) {
    if (!tags.length) return null
    return (
        <div className="flex flex-wrap gap-1">
            {tags.map(tag => (
                <span key={tag} className="inline-flex max-w-full items-center gap-1 rounded-full bg-[var(--app-subtle-bg)] px-2 py-0.5 text-xs text-[var(--app-hint)]">
                    <span className="truncate" title={tag}>{tag}</span>
                    {onRemove && <button type="button" aria-label={`Remove tag ${tag}`} className="shrink-0 rounded px-1 hover:text-[var(--app-fg)]" onClick={() => onRemove(tag)}>×</button>}
                </span>
            ))}
        </div>
    )
}
