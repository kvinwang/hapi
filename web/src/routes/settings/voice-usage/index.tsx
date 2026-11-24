import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { VOICE_PRICES, voiceLineCost, voiceUsageCost, type VoicePriceLine, type VoiceUsage, type VoiceUsageCounts } from '@hapi/protocol/voiceUsage'
import { useAppContext } from '@/lib/app-context'
import { queryKeys } from '@/lib/query-keys'
import { useTranslation } from '@/lib/use-translation'
import { SettingsScreen } from '@/routes/settings/header'
import { SettingsSection } from '@/routes/settings/controls'

type Bucket = VoiceUsage & { hour: number }

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
/** Days back to the first day, and number of days. */
const PERIODS = { today: [0, 1], yesterday: [1, 1], week: [6, 7], month: [29, 30] } as const
type Period = keyof typeof PERIODS
const FIELDS: Array<keyof VoiceUsageCounts> = ['responses', 'inputAudioTokens', 'inputTextTokens', 'outputTextTokens', 'outputAudioTokens', 'audioSeconds', 'characters']

const startOfToday = () => new Date().setHours(0, 0, 0, 0)
const yuan = (value: number) => `¥${value.toFixed(value >= 100 ? 0 : value >= 1 ? 2 : 4)}`
const count = (value: number) => Math.round(value).toLocaleString()
const cost = (buckets: Bucket[]) => buckets.reduce((sum, bucket) => sum + voiceUsageCost(bucket), 0)
const dayKey = (hour: number) => new Date(hour * HOUR_MS).toLocaleDateString()

function groupBy<K>(buckets: Bucket[], key: (bucket: Bucket) => K): Array<[K, Bucket[]]> {
    const groups = new Map<K, Bucket[]>()
    for (const bucket of buckets) groups.set(key(bucket), [...(groups.get(key(bucket)) ?? []), bucket])
    return [...groups]
}

function sum(buckets: Bucket[]): VoiceUsageCounts {
    const total = Object.fromEntries(FIELDS.map((field) => [field, 0])) as VoiceUsageCounts
    for (const bucket of buckets) for (const field of FIELDS) total[field] += bucket[field]
    return total
}

const TH = 'px-3 py-1.5 text-left font-normal text-[var(--app-hint)]'
const TD = 'px-3 py-1.5 tabular-nums'

export default function VoiceUsagePage() {
    const { t } = useTranslation()
    const { api } = useAppContext()
    const [period, setPeriod] = useState<Period>('today')
    const { data } = useQuery({
        queryKey: queryKeys.voiceUsage,
        queryFn: async () => (await api!.getVoiceUsage(startOfToday() - PERIODS.month[0] * DAY_MS)).usage,
        enabled: Boolean(api),
        refetchInterval: 10_000
    })
    const [back, days] = PERIODS[period]
    const from = startOfToday() - back * DAY_MS
    const to = from + days * DAY_MS
    const hourly = days === 1
    const buckets = (data ?? []).filter((bucket) => bucket.hour * HOUR_MS >= from && bucket.hour * HOUR_MS < to)

    const field = (name: keyof VoiceUsageCounts) => t(`settings.voiceUsage.field.${name}`)
    const unit = (line: VoicePriceLine) => `¥${line.price} / ${t(`settings.voiceUsage.per.${line.field === 'audioSeconds' ? 'second' : line.field === 'characters' ? 'tenThousandChars' : 'millionTokens'}`)}`
    const quantity = (name: keyof VoiceUsageCounts, value: number) => name === 'audioSeconds' ? `${count(value)} s (${(value / 60).toFixed(1)} min)` : count(value)

    return (
        <SettingsScreen title={t('settings.nav.voiceUsage')}>
            <div className="flex gap-1 px-3 pt-3">
                {(Object.keys(PERIODS) as Period[]).map((key) => (
                    <button key={key} type="button" onClick={() => setPeriod(key)}
                        className={`rounded-full px-3 py-1 text-sm ${period === key ? 'bg-[var(--app-link)] text-white' : 'bg-[var(--app-subtle-bg)] text-[var(--app-fg)]'}`}>
                        {t(`settings.voiceUsage.period.${key}`)}
                    </button>
                ))}
            </div>
            <SettingsSection title={`${t('settings.voiceUsage.total')} ${yuan(cost(buckets))}`} description={t('settings.voiceUsage.description')}>
                {buckets.length === 0 ? <p className="px-3 pb-3 text-sm text-[var(--app-hint)]">{t('settings.voiceUsage.empty')}</p> : null}
            </SettingsSection>
            {groupBy(buckets, (bucket) => bucket.model).map(([model, rows]) => {
                const usage = sum(rows)
                const lines = VOICE_PRICES[model] ?? []
                const unbilled = FIELDS.filter((name) => usage[name] && !lines.some((line) => line.field === name))
                return (
                    <SettingsSection key={model} title={model}>
                        <table className="w-full text-sm">
                            <thead><tr><th className={TH}>{t('settings.voiceUsage.item')}</th><th className={TH}>{t('settings.voiceUsage.quantity')}</th><th className={TH}>{t('settings.voiceUsage.unitPrice')}</th><th className={`${TH} text-right`}>{t('settings.voiceUsage.cost')}</th></tr></thead>
                            <tbody>
                                {lines.map((line) => (
                                    <tr key={line.field}>
                                        <td className="px-3 py-1.5">{field(line.field)}</td>
                                        <td className={TD}>{quantity(line.field, usage[line.field])}</td>
                                        <td className={`${TD} text-[var(--app-hint)]`}>{unit(line)}</td>
                                        <td className={`${TD} text-right`}>{yuan(voiceLineCost(usage, line))}</td>
                                    </tr>
                                ))}
                                <tr className="border-t border-[var(--app-divider)] font-medium">
                                    <td className="px-3 py-1.5" colSpan={3}>{t('settings.voiceUsage.total')}</td>
                                    <td className={`${TD} text-right`}>{yuan(cost(rows))}</td>
                                </tr>
                                {unbilled.map((name) => (
                                    <tr key={name} className="text-[var(--app-hint)]">
                                        <td className="px-3 py-1.5">{field(name)}</td>
                                        <td className={TD}>{quantity(name, usage[name])}</td>
                                        <td className="px-3 py-1.5" colSpan={2}>{t('settings.voiceUsage.unbilled')}</td>
                                    </tr>
                                ))}
                                {usage.responses ? (
                                    <tr className="text-[var(--app-hint)]">
                                        <td className="px-3 py-1.5">{t('settings.voiceUsage.perResponse')}</td>
                                        <td className={TD} colSpan={2}>
                                            {t('settings.voiceUsage.perResponseDetail', {
                                                input: count((usage.inputTextTokens + usage.inputAudioTokens) / usage.responses),
                                                output: count((usage.outputTextTokens + usage.outputAudioTokens) / usage.responses)
                                            })}
                                        </td>
                                        <td className={`${TD} text-right`}>{yuan(cost(rows) / usage.responses)}</td>
                                    </tr>
                                ) : null}
                            </tbody>
                        </table>
                    </SettingsSection>
                )
            })}
            {buckets.length ? (
                <SettingsSection title={t(hourly ? 'settings.voiceUsage.byHour' : 'settings.voiceUsage.byDay')}>
                    <table className="w-full text-sm">
                        <tbody>
                            {groupBy(buckets, (bucket) => hourly
                                ? new Date(bucket.hour * HOUR_MS).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                                : dayKey(bucket.hour)).reverse().map(([label, rows]) => (
                                <tr key={label} className="align-top">
                                    <td className="px-3 py-1.5 whitespace-nowrap">{label}</td>
                                    <td className="px-3 py-1.5 text-xs text-[var(--app-hint)]">
                                        {groupBy(rows, (bucket) => bucket.model).map(([model, modelRows]) => `${model.replace(/-realtime$/, '')} ${yuan(cost(modelRows))}`).join(' · ')}
                                    </td>
                                    <td className={`${TD} text-right`}>{yuan(cost(rows))}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </SettingsSection>
            ) : null}
        </SettingsScreen>
    )
}
