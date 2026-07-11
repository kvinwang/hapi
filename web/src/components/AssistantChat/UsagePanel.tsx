import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type {
    ClaudeUsagePayload,
    CodexUsagePayload,
    GrokCreditAmount,
    GrokUsagePayload,
    UsageRateLimit,
    UsageResponse
} from '@/types/api'
import type { LatestUsage } from '@/chat/reducer'
import { getContextBudgetTokens } from '@/chat/modelConfig'
import { useTranslation } from '@/lib/use-translation'

function getLocaleTag(locale: string): string {
    return locale === 'zh-CN' ? 'zh-CN' : 'en-US'
}

function parseResetDate(reset: string | number): Date | null {
    const date = typeof reset === 'number' ? new Date(reset * 1000) : new Date(reset)
    if (Number.isNaN(date.getTime())) return null
    return date
}

function formatAbsoluteTime(reset: string | number, localeTag: string): string {
    const date = parseResetDate(reset)
    if (!date) return String(reset)

    const now = new Date()
    const diffMs = date.getTime() - now.getTime()
    if (diffMs < 0) return date.toLocaleTimeString(localeTag, { hour: 'numeric', minute: '2-digit' })

    const diffHours = diffMs / (1000 * 60 * 60)
    if (diffHours < 24) {
        return date.toLocaleTimeString(localeTag, { hour: 'numeric', minute: '2-digit' })
    }

    return `${date.toLocaleDateString(localeTag, { month: 'short', day: 'numeric' })} ${date.toLocaleTimeString(localeTag, { hour: 'numeric', minute: '2-digit' })}`
}

function formatCountdown(target: string | number, nowMs: number, locale: string, nowLabel: string): string {
    const date = parseResetDate(target)
    if (!date) return nowLabel

    const diffMs = date.getTime() - nowMs
    if (diffMs <= 0) return nowLabel

    const totalMinutes = Math.floor(diffMs / 60000)
    const minutes = totalMinutes % 60
    const totalHours = Math.floor(totalMinutes / 60)
    const hours = totalHours % 24
    const days = Math.floor(totalHours / 24)

    if (locale === 'zh-CN') {
        if (days > 0) return `${days}天 ${hours}小时`
        if (totalHours > 0) return `${totalHours}小时 ${minutes}分钟`
        return `${Math.max(1, totalMinutes)}分钟`
    }

    if (days > 0) return `${days}d ${hours}h`
    if (totalHours > 0) return `${totalHours}h ${minutes}m`
    return `${Math.max(1, totalMinutes)}m`
}

function getBarColor(percent: number): string {
    if (percent >= 80) return 'bg-red-500'
    if (percent >= 50) return 'bg-amber-500'
    return 'bg-emerald-500'
}

function UsageBar(props: {
    label: string
    percent: number
    resetAt: string | number
    nowMs: number
}) {
    const { t, locale } = useTranslation()
    const percent = Math.floor(props.percent)
    const barColor = getBarColor(percent)
    const localeTag = getLocaleTag(locale)
    const absoluteTime = formatAbsoluteTime(props.resetAt, localeTag)
    const countdown = formatCountdown(props.resetAt, props.nowMs, locale, t('usage.now'))

    return (
        <div className="flex flex-col gap-0.5">
            <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-[var(--app-fg)]">{props.label}</span>
                <span className="text-[10px] text-[var(--app-hint)]">{t('usage.used', { percent })}</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--app-divider)]">
                <div
                    className={`h-full rounded-full transition-all ${barColor}`}
                    style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
                />
            </div>
            <span className="text-[10px] text-[var(--app-hint)]">
                {t('usage.resetsIn', { countdown, time: absoluteTime })}
            </span>
        </div>
    )
}

function InfoRow(props: { label: string; value: string }) {
    return (
        <div className="flex items-start justify-between gap-2 text-[11px]">
            <span className="text-[var(--app-hint)]">{props.label}</span>
            <span className="text-right text-[var(--app-fg)] break-all">{props.value}</span>
        </div>
    )
}

function SectionTitle(props: { title: string }) {
    return <div className="text-[11px] font-semibold text-[var(--app-hint)]">{props.title}</div>
}

function CollapsibleSection(props: {
    title: string
    children: ReactNode
    defaultOpen?: boolean
}) {
    return (
        <details
            open={props.defaultOpen}
            className="rounded-md border border-[var(--app-divider)]/80 px-2 py-1"
        >
            <summary className="cursor-pointer select-none text-[11px] font-semibold text-[var(--app-hint)]">
                {props.title}
            </summary>
            <div className="mt-2 flex flex-col gap-1.5">
                {props.children}
            </div>
        </details>
    )
}

function formatOptionalNumber(value: number | null | undefined, suffix = ''): string {
    if (value == null || Number.isNaN(value)) return '—'
    return `${value}${suffix}`
}

function formatBool(value: boolean | null | undefined, t: (key: string) => string): string {
    if (value == null) return t('usage.notAvailable')
    return value ? t('usage.yes') : t('usage.no')
}

function windowLabelBySeconds(seconds: number | null | undefined, t: (key: string) => string, fallbackKey: string): string {
    if (seconds === 18000) return t('usage.fiveHour')
    if (seconds === 604800) return t('usage.sevenDay')
    return t(fallbackKey)
}

function unwrapGrokCredit(value: GrokCreditAmount): number | null {
    if (value == null) return null
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'object' && value !== null && 'val' in value) {
        const raw = (value as { val?: unknown }).val
        if (typeof raw === 'number' && Number.isFinite(raw)) return raw
    }
    return null
}

function formatGrokCredits(value: number | null | undefined): string {
    if (value == null || Number.isNaN(value)) return '—'
    return value.toLocaleString()
}

function formatBillingMonth(year: number | null | undefined, month: number | null | undefined, localeTag: string): string {
    if (year == null || month == null || month < 1 || month > 12) return '—'
    const date = new Date(Date.UTC(year, month - 1, 1))
    return date.toLocaleDateString(localeTag, { year: 'numeric', month: 'short', timeZone: 'UTC' })
}

export function UsagePanel(props: {
    api?: ApiClient
    sessionId: string | undefined
    sessionUsage?: LatestUsage | null
    agentFlavor?: string | null
    /** Agent-reported context window (tokens), preferred over model-id heuristics. */
    contextWindowTokens?: number | null
}) {
    const { t, locale } = useTranslation()
    const localeTag = getLocaleTag(locale)
    const [data, setData] = useState<UsageResponse | null>(null)
    const [loading, setLoading] = useState(true)
    const [refreshing, setRefreshing] = useState(false)
    const [unsupported, setUnsupported] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [fetchedAt, setFetchedAt] = useState<number | null>(null)
    const [nowMs, setNowMs] = useState(() => Date.now())

    // Claude/Codex/Grok expose account rate-limit / credit usage; others fall back to session tokens.
    const providerUsageSupported = props.agentFlavor === 'claude'
        || props.agentFlavor === 'codex'
        || props.agentFlavor === 'grok'
        || props.agentFlavor == null
        || props.agentFlavor === ''

    useEffect(() => {
        const timer = setInterval(() => setNowMs(Date.now()), 30_000)
        return () => clearInterval(timer)
    }, [])

    const fetchUsage = useCallback(async (mode: 'initial' | 'refresh' = 'initial') => {
        if (!props.api || !props.sessionId || !providerUsageSupported) {
            setUnsupported(!providerUsageSupported)
            setLoading(false)
            return
        }

        if (mode === 'initial') {
            setLoading(true)
        } else {
            setRefreshing(true)
        }
        setError(null)
        setUnsupported(false)

        try {
            const result = await props.api.getSessionUsage(props.sessionId)
            setData(result)
            if (!result.success) {
                if ((result.error ?? '').toLowerCase().includes('not supported')) {
                    setUnsupported(true)
                    return
                }
                setError(result.error ?? t('usage.error'))
                return
            }
            setFetchedAt(Date.now())
        } catch (e) {
            setError(e instanceof Error ? e.message : t('usage.error'))
        } finally {
            setLoading(false)
            setRefreshing(false)
        }
    }, [props.api, props.sessionId, providerUsageSupported, t])

    useEffect(() => {
        void fetchUsage('initial')
    }, [fetchUsage])

    const fetchedAtLabel = useMemo(() => {
        if (!fetchedAt) return t('usage.notAvailable')
        return new Date(fetchedAt).toLocaleTimeString(localeTag, { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    }, [fetchedAt, localeTag, t])

    const sessionUsageSection = props.sessionUsage ? (
        <div className="flex flex-col gap-1.5">
            <SectionTitle title={t('usage.session')} />
            <InfoRow
                label={t('usage.context')}
                value={formatOptionalNumber(props.sessionUsage.contextSize)}
            />
            {(() => {
                const budget = getContextBudgetTokens(props.sessionUsage.model, {
                    windowTokens: props.contextWindowTokens
                })
                if (!budget) return null
                const pct = Math.min(100, Math.round((props.sessionUsage.contextSize / budget) * 100))
                return (
                    <InfoRow
                        label={t('usage.contextBudget')}
                        value={`${pct}% / ${formatOptionalNumber(budget)}`}
                    />
                )
            })()}
            <InfoRow
                label={t('usage.inputTokens')}
                value={formatOptionalNumber(props.sessionUsage.inputTokens)}
            />
            <InfoRow
                label={t('usage.outputTokens')}
                value={formatOptionalNumber(props.sessionUsage.outputTokens)}
            />
            {props.sessionUsage.model ? (
                <InfoRow label={t('usage.model')} value={props.sessionUsage.model} />
            ) : null}
            <InfoRow
                label={t('usage.updatedAt')}
                value={new Date(props.sessionUsage.timestamp).toLocaleTimeString(localeTag, {
                    hour: 'numeric',
                    minute: '2-digit',
                    second: '2-digit'
                })}
            />
        </div>
    ) : null

    if (loading && providerUsageSupported) {
        return (
            <div className="px-3 py-3">
                <span className="text-xs text-[var(--app-hint)]">{t('usage.loading')}</span>
            </div>
        )
    }

    // Prefer session-token fallback for agents without account rate-limit APIs (Grok, etc.)
    if (unsupported || !providerUsageSupported) {
        if (sessionUsageSection) {
            return (
                <div className="flex flex-col gap-3 px-3 py-3">
                    <span className="text-xs font-semibold text-[var(--app-hint)]">{t('usage.title')}</span>
                    {sessionUsageSection}
                </div>
            )
        }
        return (
            <div className="px-3 py-3">
                <span className="text-xs text-[var(--app-hint)]">{t('usage.unsupported')}</span>
            </div>
        )
    }

    if (error) {
        return (
            <div className="px-3 py-3">
                <span className="text-xs text-red-500">{error}</span>
                {sessionUsageSection ? <div className="mt-3">{sessionUsageSection}</div> : null}
            </div>
        )
    }

    if (!data || (data.provider !== 'claude' && data.provider !== 'codex' && data.provider !== 'grok')) {
        if (sessionUsageSection) {
            return (
                <div className="flex flex-col gap-3 px-3 py-3">
                    <span className="text-xs font-semibold text-[var(--app-hint)]">{t('usage.title')}</span>
                    {sessionUsageSection}
                </div>
            )
        }
        return (
            <div className="px-3 py-3">
                <span className="text-xs text-[var(--app-hint)]">{t('usage.unavailable')}</span>
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-3 px-3 py-3">
            <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[var(--app-hint)]">{t('usage.title')}</span>
                <button
                    type="button"
                    onClick={() => void fetchUsage('refresh')}
                    disabled={refreshing}
                    className="rounded border border-[var(--app-divider)] px-2 py-0.5 text-[10px] text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {refreshing ? t('usage.refreshing') : t('usage.refresh')}
                </button>
            </div>

            {data.provider === 'claude' ? (
                (() => {
                    const usage = data.usage as ClaudeUsagePayload | undefined
                    if (!usage) {
                        return <InfoRow label={t('usage.info')} value={t('usage.unavailable')} />
                    }

                    const windows: Array<{ label: string; limit: UsageRateLimit | null | undefined }> = [
                        { label: t('usage.fiveHour'), limit: usage.five_hour },
                        { label: t('usage.sevenDay'), limit: usage.seven_day },
                        { label: t('usage.opus'), limit: usage.seven_day_opus },
                        { label: t('usage.sonnet'), limit: usage.seven_day_sonnet }
                    ]

                    return (
                        <>
                            <SectionTitle title={t('usage.windows')} />
                            {windows.map((window) => window.limit ? (
                                <UsageBar
                                    key={window.label}
                                    label={window.label}
                                    percent={window.limit.utilization}
                                    resetAt={window.limit.resets_at}
                                    nowMs={nowMs}
                                />
                            ) : (
                                <InfoRow key={window.label} label={window.label} value={t('usage.notAvailable')} />
                            ))}

                            <CollapsibleSection title={t('usage.other')}>
                                <InfoRow label={t('usage.updatedAt')} value={fetchedAtLabel} />
                                <InfoRow label={t('usage.isEnabled')} value={formatBool(usage.extra_usage?.is_enabled, t)} />
                                <InfoRow label={t('usage.monthlyLimit')} value={formatOptionalNumber(usage.extra_usage?.monthly_limit)} />
                                <InfoRow label={t('usage.usedCredits')} value={formatOptionalNumber(usage.extra_usage?.used_credits)} />
                                <InfoRow
                                    label={t('usage.utilization')}
                                    value={usage.extra_usage?.utilization == null ? '—' : `${usage.extra_usage.utilization}%`}
                                />
                            </CollapsibleSection>
                        </>
                    )
                })()
            ) : data.provider === 'grok' ? (
                (() => {
                    const usage = data.usage as GrokUsagePayload | undefined
                    if (!usage) {
                        return <InfoRow label={t('usage.info')} value={t('usage.unavailable')} />
                    }

                    const config = usage.config ?? usage
                    const periodType = (config.currentPeriod?.type ?? '').toUpperCase()
                    const isWeekly = periodType.includes('WEEKLY')
                    const isMonthlyPeriod = periodType.includes('MONTHLY')
                    const creditPercent = typeof config.creditUsagePercent === 'number'
                        && Number.isFinite(config.creditUsagePercent)
                        ? Math.min(100, Math.max(0, config.creditUsagePercent))
                        : null
                    const rollingStart = config.currentPeriod?.start ?? config.billingPeriodStart ?? null
                    const rollingEnd = config.currentPeriod?.end ?? config.billingPeriodEnd ?? null
                    const rollingLabel = isWeekly
                        ? t('usage.weeklyLimit')
                        : isMonthlyPeriod
                            ? t('usage.monthlyLimit')
                            : t('usage.credits')

                    const used = unwrapGrokCredit(config.used)
                    const monthlyLimit = unwrapGrokCredit(config.monthlyLimit)
                    const onDemandCap = unwrapGrokCredit(config.onDemandCap)
                    const onDemandUsed = unwrapGrokCredit(config.onDemandUsed)
                    const prepaidBalance = unwrapGrokCredit(config.prepaidBalance)
                    const monthlyPeriodStart = config.monthlyPeriodStart ?? null
                    const monthlyPeriodEnd = config.monthlyPeriodEnd ?? null
                    const monthlyPercent = used != null && monthlyLimit != null && monthlyLimit > 0
                        ? Math.min(100, Math.round((used / monthlyLimit) * 1000) / 10)
                        : null
                    const remaining = used != null && monthlyLimit != null
                        ? Math.max(0, monthlyLimit - used)
                        : null
                    const history = Array.isArray(config.history) ? config.history : []
                    const productUsage = Array.isArray(config.productUsage) ? config.productUsage : []

                    return (
                        <>
                            <SectionTitle title={t('usage.windows')} />
                            {/* Matches Grok TUI /usage weekly (or period) bar from ?format=credits */}
                            {creditPercent != null && rollingEnd ? (
                                <UsageBar
                                    label={rollingLabel}
                                    percent={creditPercent}
                                    resetAt={rollingEnd}
                                    nowMs={nowMs}
                                />
                            ) : creditPercent != null ? (
                                <InfoRow label={rollingLabel} value={`${Math.floor(creditPercent)}%`} />
                            ) : (
                                <InfoRow label={t('usage.weeklyLimit')} value={t('usage.notAvailable')} />
                            )}

                            {/* Calendar-month pool from default /v1/billing */}
                            {monthlyPercent != null && monthlyPeriodEnd ? (
                                <UsageBar
                                    label={t('usage.monthlyLimit')}
                                    percent={monthlyPercent}
                                    resetAt={monthlyPeriodEnd}
                                    nowMs={nowMs}
                                />
                            ) : monthlyPercent != null ? (
                                <InfoRow
                                    label={t('usage.monthlyLimit')}
                                    value={`${Math.floor(monthlyPercent)}%`}
                                />
                            ) : null}

                            <SectionTitle title={t('usage.credits')} />
                            {used != null || monthlyLimit != null ? (
                                <InfoRow
                                    label={t('usage.usedCredits')}
                                    value={used != null && monthlyLimit != null
                                        ? `${formatGrokCredits(used)} / ${formatGrokCredits(monthlyLimit)}`
                                        : formatGrokCredits(used)}
                                />
                            ) : null}
                            {remaining != null ? (
                                <InfoRow label={t('usage.creditsLeft')} value={formatGrokCredits(remaining)} />
                            ) : null}
                            <InfoRow label={t('usage.onDemandCap')} value={formatGrokCredits(onDemandCap)} />
                            {onDemandUsed != null ? (
                                <InfoRow label={t('usage.onDemandUsed')} value={formatGrokCredits(onDemandUsed)} />
                            ) : null}
                            {prepaidBalance != null ? (
                                <InfoRow label={t('usage.prepaidBalance')} value={formatGrokCredits(prepaidBalance)} />
                            ) : null}
                            {rollingStart ? (
                                <InfoRow
                                    label={isWeekly ? t('usage.weeklyPeriodStart') : t('usage.periodStart')}
                                    value={formatAbsoluteTime(rollingStart, localeTag)}
                                />
                            ) : null}
                            {rollingEnd ? (
                                <InfoRow
                                    label={isWeekly ? t('usage.weeklyPeriodEnd') : t('usage.periodEnd')}
                                    value={formatAbsoluteTime(rollingEnd, localeTag)}
                                />
                            ) : null}
                            {monthlyPeriodStart ? (
                                <InfoRow
                                    label={t('usage.monthlyPeriodStart')}
                                    value={formatAbsoluteTime(monthlyPeriodStart, localeTag)}
                                />
                            ) : null}
                            {monthlyPeriodEnd ? (
                                <InfoRow
                                    label={t('usage.monthlyPeriodEnd')}
                                    value={formatAbsoluteTime(monthlyPeriodEnd, localeTag)}
                                />
                            ) : null}
                            <InfoRow label={t('usage.updatedAt')} value={fetchedAtLabel} />

                            {productUsage.length > 0 ? (
                                <CollapsibleSection title={t('usage.productUsage')}>
                                    {productUsage.map((entry, index) => {
                                        const name = entry.product?.trim() || t('usage.notAvailable')
                                        const pct = typeof entry.usagePercent === 'number'
                                            && Number.isFinite(entry.usagePercent)
                                            ? `${Math.floor(entry.usagePercent)}%`
                                            : t('usage.notAvailable')
                                        return (
                                            <InfoRow
                                                key={`${name}-${index}`}
                                                label={name}
                                                value={pct}
                                            />
                                        )
                                    })}
                                </CollapsibleSection>
                            ) : null}

                            {history.length > 0 ? (
                                <CollapsibleSection title={t('usage.billingHistory')}>
                                    {history.map((entry, index) => {
                                        const year = entry.billingCycle?.year ?? null
                                        const month = entry.billingCycle?.month ?? null
                                        const total = unwrapGrokCredit(entry.totalUsed)
                                        const included = unwrapGrokCredit(entry.includedUsed)
                                        const onDemand = unwrapGrokCredit(entry.onDemandUsed)
                                        return (
                                            <InfoRow
                                                key={`${year ?? 'y'}-${month ?? 'm'}-${index}`}
                                                label={formatBillingMonth(year, month, localeTag)}
                                                value={t('usage.historyEntry', {
                                                    total: formatGrokCredits(total),
                                                    included: formatGrokCredits(included),
                                                    onDemand: formatGrokCredits(onDemand)
                                                })}
                                            />
                                        )
                                    })}
                                </CollapsibleSection>
                            ) : null}

                            {sessionUsageSection}
                        </>
                    )
                })()
            ) : (
                (() => {
                    const usage = data.usage as CodexUsagePayload | undefined
                    if (!usage) {
                        return <InfoRow label={t('usage.info')} value={t('usage.unavailable')} />
                    }

                    const mainPrimary = usage.rate_limit?.primary_window
                    const mainSecondary = usage.rate_limit?.secondary_window
                    const reviewPrimary = usage.code_review_rate_limit?.primary_window
                    const reviewSecondary = usage.code_review_rate_limit?.secondary_window

                    const creditsLocal = Array.isArray(usage.credits?.approx_local_messages)
                        ? usage.credits?.approx_local_messages.join(' / ')
                        : '—'
                    const creditsCloud = Array.isArray(usage.credits?.approx_cloud_messages)
                        ? usage.credits?.approx_cloud_messages.join(' / ')
                        : '—'

                    return (
                        <>
                            <SectionTitle title={t('usage.windows')} />
                            {mainPrimary?.used_percent != null && mainPrimary.reset_at != null ? (
                                <UsageBar
                                    label={windowLabelBySeconds(mainPrimary.limit_window_seconds, t, 'usage.primary')}
                                    percent={mainPrimary.used_percent}
                                    resetAt={mainPrimary.reset_at}
                                    nowMs={nowMs}
                                />
                            ) : (
                                <InfoRow label={t('usage.primary')} value={t('usage.notAvailable')} />
                            )}
                            {mainSecondary?.used_percent != null && mainSecondary.reset_at != null ? (
                                <UsageBar
                                    label={windowLabelBySeconds(mainSecondary.limit_window_seconds, t, 'usage.secondary')}
                                    percent={mainSecondary.used_percent}
                                    resetAt={mainSecondary.reset_at}
                                    nowMs={nowMs}
                                />
                            ) : (
                                <InfoRow label={t('usage.secondary')} value={t('usage.notAvailable')} />
                            )}

                            <CollapsibleSection title={t('usage.codeReviewRateLimit')}>
                                {reviewPrimary?.used_percent != null && reviewPrimary.reset_at != null ? (
                                    <UsageBar
                                        label={windowLabelBySeconds(reviewPrimary.limit_window_seconds, t, 'usage.primary')}
                                        percent={reviewPrimary.used_percent}
                                        resetAt={reviewPrimary.reset_at}
                                        nowMs={nowMs}
                                    />
                                ) : (
                                    <InfoRow label={t('usage.primary')} value={t('usage.notAvailable')} />
                                )}
                                {reviewSecondary?.used_percent != null && reviewSecondary.reset_at != null ? (
                                    <UsageBar
                                        label={windowLabelBySeconds(reviewSecondary.limit_window_seconds, t, 'usage.secondary')}
                                        percent={reviewSecondary.used_percent}
                                        resetAt={reviewSecondary.reset_at}
                                        nowMs={nowMs}
                                    />
                                ) : (
                                    <InfoRow label={t('usage.secondary')} value={t('usage.notAvailable')} />
                                )}
                            </CollapsibleSection>

                            <CollapsibleSection title={t('usage.account')}>
                                <InfoRow label={t('usage.planType')} value={usage.plan_type ?? '—'} />
                                <InfoRow label={t('usage.email')} value={usage.email ?? '—'} />
                                <InfoRow label={t('usage.updatedAt')} value={fetchedAtLabel} />
                                <InfoRow label={t('usage.balance')} value={usage.credits?.balance ?? '—'} />
                                <InfoRow label={t('usage.approxLocalMessages')} value={creditsLocal} />
                                <InfoRow label={t('usage.approxCloudMessages')} value={creditsCloud} />
                            </CollapsibleSection>
                        </>
                    )
                })()
            )}
        </div>
    )
}
