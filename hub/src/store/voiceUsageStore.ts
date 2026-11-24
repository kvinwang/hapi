import type { Database } from 'bun:sqlite'
import type { VoiceUsage } from '@hapi/protocol/voiceUsage'

export type VoiceUsageBucket = VoiceUsage & { hour: number }

const HOUR_MS = 3_600_000

export function createVoiceUsageTable(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS voice_usage (
            namespace TEXT NOT NULL,
            hour INTEGER NOT NULL,
            model TEXT NOT NULL,
            audio_seconds REAL NOT NULL DEFAULT 0,
            input_text_tokens INTEGER NOT NULL DEFAULT 0,
            input_audio_tokens INTEGER NOT NULL DEFAULT 0,
            output_text_tokens INTEGER NOT NULL DEFAULT 0,
            output_audio_tokens INTEGER NOT NULL DEFAULT 0,
            characters INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (namespace, hour, model)
        )
    `)
}

export function addVoiceUsageResponses(db: Database): void {
    db.exec('ALTER TABLE voice_usage ADD COLUMN responses INTEGER NOT NULL DEFAULT 0')
}

/** Voice usage summed per namespace, model and hour (hours since the epoch). */
export class VoiceUsageStore {
    constructor(private readonly db: Database) {}

    add(namespace: string, usage: VoiceUsage[], now = Date.now()): void {
        const insert = this.db.prepare(`
            INSERT INTO voice_usage (namespace, hour, model, responses, audio_seconds, input_text_tokens, input_audio_tokens, output_text_tokens, output_audio_tokens, characters)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(namespace, hour, model) DO UPDATE SET
                responses = responses + excluded.responses,
                audio_seconds = audio_seconds + excluded.audio_seconds,
                input_text_tokens = input_text_tokens + excluded.input_text_tokens,
                input_audio_tokens = input_audio_tokens + excluded.input_audio_tokens,
                output_text_tokens = output_text_tokens + excluded.output_text_tokens,
                output_audio_tokens = output_audio_tokens + excluded.output_audio_tokens,
                characters = characters + excluded.characters
        `)
        const hour = Math.floor(now / HOUR_MS)
        this.db.transaction(() => {
            for (const u of usage) {
                insert.run(namespace, hour, u.model, u.responses, u.audioSeconds, u.inputTextTokens, u.inputAudioTokens, u.outputTextTokens, u.outputAudioTokens, u.characters)
            }
        })()
    }

    list(namespace: string, sinceMs: number): VoiceUsageBucket[] {
        return this.db.prepare(`
            SELECT hour, model, responses, audio_seconds AS audioSeconds, input_text_tokens AS inputTextTokens, input_audio_tokens AS inputAudioTokens,
                output_text_tokens AS outputTextTokens, output_audio_tokens AS outputAudioTokens, characters
            FROM voice_usage WHERE namespace = ? AND hour >= ? ORDER BY hour, model
        `).all(namespace, Math.floor(sinceMs / HOUR_MS)) as VoiceUsageBucket[]
    }
}
