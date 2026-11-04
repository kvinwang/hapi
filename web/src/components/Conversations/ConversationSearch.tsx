export function ConversationSearch({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) {
    return <input
        type="search"
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder={label}
        aria-label={label}
        className="mt-2 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 py-1.5 text-sm text-[var(--app-fg)] outline-none placeholder:text-[var(--app-hint)] focus:border-[var(--app-link)]"
    />
}
