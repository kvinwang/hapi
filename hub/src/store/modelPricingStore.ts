import type { Database } from 'bun:sqlite'

export type ModelPricing = {
    model: string
    inputPerMillion: number
    outputPerMillion: number
    cachedInputPerMillion: number
    updatedAt: number
}

type PricingRow = {
    model: string
    input_per_million: number
    output_per_million: number
    cached_input_per_million: number
    updated_at: number
}

function fromRow(row: PricingRow): ModelPricing {
    return {
        model: row.model,
        inputPerMillion: row.input_per_million,
        outputPerMillion: row.output_per_million,
        cachedInputPerMillion: row.cached_input_per_million,
        updatedAt: row.updated_at
    }
}

export class ModelPricingStore {
    constructor(private readonly db: Database) {}

    list(namespace: string): ModelPricing[] {
        return (this.db.prepare(
            'SELECT model, input_per_million, output_per_million, cached_input_per_million, updated_at FROM model_pricing WHERE namespace = ? ORDER BY model'
        ).all(namespace) as PricingRow[]).map(fromRow)
    }

    get(namespace: string, model: string): ModelPricing | null {
        const row = this.db.prepare(
            'SELECT model, input_per_million, output_per_million, cached_input_per_million, updated_at FROM model_pricing WHERE namespace = ? AND model = ?'
        ).get(namespace, model) as PricingRow | undefined
        return row ? fromRow(row) : null
    }

    set(namespace: string, pricing: Omit<ModelPricing, 'updatedAt'>): ModelPricing {
        const updatedAt = Date.now()
        this.db.prepare(`
            INSERT INTO model_pricing (namespace, model, input_per_million, output_per_million, cached_input_per_million, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(namespace, model) DO UPDATE SET
                input_per_million = excluded.input_per_million,
                output_per_million = excluded.output_per_million,
                cached_input_per_million = excluded.cached_input_per_million,
                updated_at = excluded.updated_at
        `).run(namespace, pricing.model, pricing.inputPerMillion, pricing.outputPerMillion, pricing.cachedInputPerMillion, updatedAt)
        return { ...pricing, updatedAt }
    }

    delete(namespace: string, model: string): boolean {
        return this.db.prepare('DELETE FROM model_pricing WHERE namespace = ? AND model = ?').run(namespace, model).changes > 0
    }
}
