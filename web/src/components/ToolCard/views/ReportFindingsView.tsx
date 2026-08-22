import type { ReactNode } from 'react'
import type { ToolViewProps } from '@/components/ToolCard/views/_all'
import type { ReviewFinding } from '@/components/ToolCard/reportFindings'
import {
    findingHeadline,
    formatFindingLocation,
    parseReportFindings
} from '@/components/ToolCard/reportFindings'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { resolveDisplayPath } from '@/utils/path'
import type { SessionMetadataSummary } from '@/types/api'
import { cn } from '@/lib/utils'

const INLINE_LIMIT = 5

const OUTCOME_LABELS: Record<string, string> = {
    fixed: 'fixed',
    skipped: 'skipped',
    no_change_needed: 'no change needed'
}

function Pill(props: { className: string; children: ReactNode }) {
    return (
        <span className={cn(
            'inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
            props.className
        )}>
            {props.children}
        </span>
    )
}

function VerdictPill(props: { finding: ReviewFinding }) {
    const verdict = props.finding.verdict
    if (!verdict) return null
    const tone = verdict === 'CONFIRMED'
        ? 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300'
        : 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
    return <Pill className={tone}>{verdict}</Pill>
}

function OutcomePill(props: { finding: ReviewFinding }) {
    const outcome = props.finding.outcome
    if (!outcome) return null
    const tone = outcome === 'fixed'
        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
        : outcome === 'no_change_needed'
            ? 'bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300'
            : 'bg-[var(--app-border)] text-[var(--app-hint)]'
    return <Pill className={tone}>{OUTCOME_LABELS[outcome]}</Pill>
}

function CategoryPill(props: { finding: ReviewFinding }) {
    if (!props.finding.category) return null
    return (
        <Pill className="bg-[var(--app-border)] text-[var(--app-hint)] normal-case tracking-normal">
            {props.finding.category}
        </Pill>
    )
}

function locationOf(finding: ReviewFinding, metadata: SessionMetadataSummary | null): string | null {
    const display = finding.file ? resolveDisplayPath(finding.file, metadata) : null
    return formatFindingLocation(finding, display)
}

/** The card title already carries the count, so the inline list only adds the effort level. */
function LevelLine(props: { level: string | null; count: number; showCount: boolean }) {
    if (!props.showCount && !props.level) return null
    const noun = props.count === 1 ? 'finding' : 'findings'
    const parts: string[] = []
    if (props.showCount) parts.push(`${props.count} ${noun}`)
    if (props.level) parts.push(`${props.level} effort`)
    return (
        <div className="text-xs text-[var(--app-hint)]">
            {parts.join(' · ')}
        </div>
    )
}

/** Compact list rendered inline on the tool card. */
export function ReportFindingsView(props: ToolViewProps) {
    const { findings, level } = parseReportFindings(props.block.tool.input, props.block.tool.result)

    if (findings.length === 0) {
        return (
            <div className="text-sm text-[var(--app-hint)]">
                No findings reported.
            </div>
        )
    }

    const visible = findings.slice(0, INLINE_LIMIT)
    const remaining = findings.length - visible.length

    return (
        <div className="flex flex-col gap-2">
            <LevelLine level={level} count={findings.length} showCount={false} />
            {visible.map((finding, idx) => {
                const location = locationOf(finding, props.metadata)
                return (
                    <div
                        key={idx}
                        className="rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5"
                    >
                        <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-mono text-xs text-[var(--app-hint)]">{idx + 1}.</span>
                            {location ? (
                                <span className="min-w-0 break-all font-mono text-xs text-[var(--app-hint)]">
                                    {location}
                                </span>
                            ) : null}
                            <VerdictPill finding={finding} />
                            <OutcomePill finding={finding} />
                            <CategoryPill finding={finding} />
                        </div>
                        <div className="mt-0.5 break-words text-sm text-[var(--app-fg)]">
                            {findingHeadline(finding)}
                        </div>
                    </div>
                )
            })}
            {remaining > 0 ? (
                <div className="text-xs italic text-[var(--app-hint)]">
                    (+{remaining} more)
                </div>
            ) : null}
        </div>
    )
}

/** Full detail rendered in the tool dialog: summary + failure scenario per finding. */
export function ReportFindingsFullView(props: ToolViewProps) {
    const { findings, level } = parseReportFindings(props.block.tool.input, props.block.tool.result)

    if (findings.length === 0) {
        return (
            <div className="text-sm text-[var(--app-hint)]">
                No findings reported.
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-3">
            <LevelLine level={level} count={findings.length} showCount />
            {findings.map((finding, idx) => {
                const location = locationOf(finding, props.metadata)
                return (
                    <div
                        key={idx}
                        className="rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-3"
                    >
                        <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-mono text-xs text-[var(--app-hint)]">{idx + 1}.</span>
                            {location ? (
                                <span className="min-w-0 break-all font-mono text-xs text-[var(--app-hint)]">
                                    {location}
                                </span>
                            ) : null}
                            <VerdictPill finding={finding} />
                            <OutcomePill finding={finding} />
                            <CategoryPill finding={finding} />
                        </div>

                        {finding.shortSummary ? (
                            <div className="mt-1.5 break-words text-sm font-medium text-[var(--app-fg)]">
                                {finding.shortSummary}
                            </div>
                        ) : null}

                        {finding.summary ? (
                            <div className="mt-1 [&_.aui-md]:text-sm">
                                <MarkdownRenderer content={finding.summary} />
                            </div>
                        ) : null}

                        {finding.failureScenario ? (
                            <div className="mt-2 border-l-2 border-[var(--app-border)] pl-2">
                                <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--app-hint)]">
                                    Failure scenario
                                </div>
                                <div className="mt-0.5 [&_.aui-md]:text-sm [&_.aui-md]:text-[var(--app-hint)]">
                                    <MarkdownRenderer content={finding.failureScenario} />
                                </div>
                            </div>
                        ) : null}
                    </div>
                )
            })}
        </div>
    )
}
