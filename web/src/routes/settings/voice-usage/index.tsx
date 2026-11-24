import { useQuery } from '@tanstack/react-query'
import { voiceUsageCost, type VoiceUsage } from '@hapi/protocol/voiceUsage'
import { useAppContext } from '@/lib/app-context'
import { queryKeys } from '@/lib/query-keys'
import { useTranslation } from '@/lib/use-translation'
import { SettingsScreen } from '@/routes/settings/header'
import { SettingsInfoRow, SettingsSection } from '@/routes/settings/controls'

type Bucket = VoiceUsage & { hour: number }

const HOUR_MS = 3_600_000
const DAYS = 7

const yuan = (value: number) => `¥${value.toFixed(value < 1 ? 3 : 2)}`
const cost = (buckets: Bucket[]) => buckets.reduce((sum, bucket) => sum + (voiceUsageCost(bucket) ?? 0), 0)
const dayOf = (hour: number) => new Date(hour * HOUR_MS).toLocaleDateString()

function groupBy<K>(buckets: Bucket[], key: (bucket: Bucket) => K): Map<K, Bucket[]> {
    const groups = new Map<K, Bucket[]>()
    for (const bucket of buckets) groups.set(key(bucket), [...(groups.get(key(bucket)) ?? []), bucket])
    return groups
}

function sum(buckets: Bucket[]): Omit<VoiceUsage, 'model'> {
    return buckets.reduce((total, b) => ({
        audioSeconds: total.audioSeconds + b.audioSeconds,
        inputTextTokens: total.inputTextTokens + b.inputTextTokens,
        inputAudioTokens: total.inputAudioTokens + b.inputAudioTokens,
        outputTextTokens: total.outputTextTokens + b.outputTextTokens,
        outputAudioTokens: total.outputAudioTokens + b.outputAudioTokens,
        characters: total.characters + b.characters
    }), { audioSeconds: 0, inputTextTokens: 0, inputAudioTokens: 0, outputTextTokens: 0, outputAudioTokens: 0, characters: 0 })
}

export default function VoiceUsagePage() {
    const { t } = useTranslation()
    const { api } = useAppContext()
    const since = new Date().setHours(0, 0, 0, 0) - (DAYS - 1) * 24 * HOUR_MS
    const { data } = useQuery({
        queryKey: queryKeys.voiceUsage,
        queryFn: async () => (await api!.getVoiceUsage(since)).usage,
        enabled: Boolean(api),
        refetchInterval: 10_000
    })
    const buckets = data ?? []
    const today = buckets.filter((bucket) => dayOf(bucket.hour) === new Date().toLocaleDateString())

    const detail = (model: string, rows: Bucket[]) => {
        const u = sum(rows)
        return [
            u.audioSeconds ? `${t('settings.voiceUsage.audio')} ${(u.audioSeconds / 60).toFixed(1)} min` : '',
            u.inputTextTokens + u.inputAudioTokens ? `${t('settings.voiceUsage.inputTokens')} ${u.inputTextTokens + u.inputAudioTokens} (audio ${u.inputAudioTokens})` : '',
            u.outputTextTokens + u.outputAudioTokens ? `${t('settings.voiceUsage.outputTokens')} ${u.outputTextTokens + u.outputAudioTokens} (audio ${u.outputAudioTokens})` : '',
            u.characters ? `${t('settings.voiceUsage.chars')} ${u.characters}` : ''
        ].filter(Boolean).join(' · ') || model
    }

    return (
        <SettingsScreen title={t('settings.nav.voiceUsage')}>
            <SettingsSection title={`${t('settings.voiceUsage.today')} ${yuan(cost(today))}`} description={t('settings.voiceUsage.description')}>
                {today.length === 0 ? <p className="px-3 pb-3 text-sm text-[var(--app-hint)]">{t('settings.voiceUsage.empty')}</p> : null}
                {[...groupBy(today, (bucket) => bucket.model)].map(([model, rows]) => (
                    <div key={model} className="px-3 py-2">
                        <div className="flex justify-between text-sm">
                            <span>{model}</span>
                            <span className="tabular-nums">{yuan(cost(rows))}</span>
                        </div>
                        <div className="text-xs text-[var(--app-hint)]">{detail(model, rows)}</div>
                    </div>
                ))}
            </SettingsSection>
            <SettingsSection title={t('settings.voiceUsage.hourly')}>
                {[...groupBy(today, (bucket) => bucket.hour)].reverse().map(([hour, rows]) => (
                    <SettingsInfoRow key={hour} label={new Date(hour * HOUR_MS).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}>
                        <span className="tabular-nums">{yuan(cost(rows))}</span>
                    </SettingsInfoRow>
                ))}
            </SettingsSection>
            <SettingsSection title={`${t('settings.voiceUsage.week')} ${yuan(cost(buckets))}`}>
                {[...groupBy(buckets, (bucket) => dayOf(bucket.hour))].reverse().map(([day, rows]) => (
                    <SettingsInfoRow key={day} label={day}>
                        <span className="tabular-nums">{yuan(cost(rows))}</span>
                    </SettingsInfoRow>
                ))}
            </SettingsSection>
        </SettingsScreen>
    )
}
