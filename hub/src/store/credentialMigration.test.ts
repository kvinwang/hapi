import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { migrateCredentialsToV23 } from './credentialMigration'

function legacyDb(rows: Array<[string, string, unknown]>) {
    const db = new Database(':memory:')
    db.exec(`
        CREATE TABLE credentials (id TEXT PRIMARY KEY, namespace TEXT NOT NULL, name TEXT NOT NULL, agent_type TEXT NOT NULL,
            config TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE INDEX idx_credentials_agent_type ON credentials(namespace, agent_type);
    `)
    rows.forEach(([id, agentType, config], index) => db.prepare('INSERT INTO credentials VALUES (?, ?, ?, ?, ?, 0, ?)')
        .run(id, 'default', id, agentType, JSON.stringify(config), rows.length - index))
    return db
}

const codexToml = (model: string) => `model = "${model}"\nmodel_provider = "gw"\n[model_providers.gw]\nbase_url = "https://gw.invalid/v1"\nwire_api = "responses"\n`

describe('credential migration v23', () => {
    it('converts API-key credentials, merges accounts into model lists and drops subscriptions', () => {
        const db = legacyDb([
            ['mp', 'model-provider', { provider: 'gw', model: 'm1', protocol: 'openai-responses', baseUrl: 'https://gw.invalid/v1', apiKey: 'k', contextWindow: 1000 }],
            ['codex', 'codex', { auth: { OPENAI_API_KEY: 'k' }, config: codexToml('m2') }],
            ['other-key', 'codex', { auth: { OPENAI_API_KEY: 'k2' }, config: codexToml('m1') }],
            ['chatgpt', 'codex', { auth: { auth_mode: 'chatgpt', tokens: {} }, config: 'model = "gpt"' }],
            ['claude', 'claude', { credentials: { claudeAiOauth: {} } }]
        ])
        migrateCredentialsToV23(db)
        const rows = db.prepare('SELECT * FROM credentials ORDER BY id').all() as Array<{ id: string; config: string; agent_type?: string }>
        expect(rows.map((row) => row.id)).toEqual(['mp', 'other-key'])
        expect(rows[0].agent_type).toBeUndefined()
        expect(JSON.parse(rows[0].config)).toEqual({
            provider: 'gw',
            apiKey: 'k',
            endpoints: { 'openai-responses': 'https://gw.invalid/v1' },
            models: [{ id: 'm1', contextWindow: 1000 }, { id: 'm2' }],
            defaultModel: 'm1'
        })
        expect(JSON.parse(rows[1].config).models).toEqual([{ id: 'm1' }])
    })
})
