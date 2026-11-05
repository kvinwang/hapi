import type { ReactNode } from 'react'
import { useTranslation } from '@/lib/use-translation'

function Section<Value extends string>(props: {
    title: string
    options: { value: Value; label: string; description?: string }[]
    selected: Value
    disabled: boolean
    inlineDescription?: boolean
    onSelect: (value: Value) => void
}) {
    return (
        <div className="py-2">
            <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">{props.title}</div>
            {props.options.map(({ value, label, description }) => {
                const selected = props.selected === value
                return (
                    <button
                        key={value}
                        type="button"
                        disabled={props.disabled}
                        title={props.inlineDescription ? undefined : description}
                        className={`flex w-full gap-2 px-3 py-2 text-left text-sm transition-colors ${props.inlineDescription ? 'items-start' : 'items-center'} ${props.disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'}`}
                        onClick={() => props.onSelect(value)}
                        onMouseDown={event => event.preventDefault()}
                    >
                        <div className={`${props.inlineDescription ? 'mt-0.5 shrink-0 ' : ''}flex h-4 w-4 items-center justify-center rounded-full border-2 ${selected ? 'border-[var(--app-link)]' : 'border-[var(--app-hint)]'}`}>
                            {selected ? <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" /> : null}
                        </div>
                        <span className="flex min-w-0 flex-col">
                            <span className={selected ? 'text-[var(--app-link)]' : ''}>{label}</span>
                            {props.inlineDescription && description ? <span className="text-xs text-[var(--app-hint)]">{description}</span> : null}
                        </span>
                    </button>
                )
            })}
        </div>
    )
}

const DIVIDER = <div className="mx-3 h-px bg-[var(--app-divider)]" />

/** Permission, model and effort choices of a coding agent; absent sections are left out. */
export function AgentSettingsPanel<Permission extends string, Model extends string, Effort extends string>(props: {
    disabled: boolean
    permission?: { options: { mode: Permission; label: string }[]; selected: Permission; onSelect: (mode: Permission) => void }
    /** Replaces the plain model list, for agents that also choose a provider. */
    modelPicker?: ReactNode
    model?: { options: { mode: Model; label: string; description?: string }[]; selected: Model; onSelect: (mode: Model) => void }
    effort?: { options: { mode: Effort; label: string; description?: string }[]; selected: Effort; onSelect: (mode: Effort) => void }
}) {
    const { t } = useTranslation()
    const { permission, model, effort, disabled, modelPicker } = props
    const hasModel = Boolean(modelPicker || model)
    const values = <Mode extends string>(options: { mode: Mode; label: string; description?: string }[]) =>
        options.map(({ mode, ...option }) => ({ value: mode, ...option }))
    return (
        <>
            {permission ? <Section title={t('misc.permissionMode')} options={values(permission.options)} selected={permission.selected} disabled={disabled} onSelect={permission.onSelect} /> : null}
            {permission && (hasModel || effort) ? DIVIDER : null}
            {modelPicker ?? (model ? <Section title={t('misc.model')} options={values(model.options)} selected={model.selected} disabled={disabled} inlineDescription onSelect={model.onSelect} /> : null)}
            {hasModel && effort ? DIVIDER : null}
            {effort ? <Section title={t('misc.effort')} options={values(effort.options)} selected={effort.selected} disabled={disabled} onSelect={effort.onSelect} /> : null}
        </>
    )
}
