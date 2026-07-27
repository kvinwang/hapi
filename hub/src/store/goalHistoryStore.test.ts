import { describe, expect, it } from 'bun:test'
import { Store } from './index'

describe('GoalHistoryStore', () => {
    it('records goals per namespace, most recently used first', () => {
        const store = new Store(':memory:')
        store.goalHistory.record('a', { objective: 'ship the release', tokenBudget: 1000 })
        store.goalHistory.record('a', { objective: 'write the docs' })
        store.goalHistory.record('b', { objective: 'other tenant goal' })

        const goals = store.goalHistory.list('a')
        expect(goals.map(goal => goal.objective)).toEqual(['write the docs', 'ship the release'])
        expect(goals[1]?.tokenBudget).toBe(1000)
        expect(goals[0]?.tokenBudget).toBeNull()
        expect(store.goalHistory.list('b')).toHaveLength(1)
    })

    it('deduplicates by objective and bumps the use count', () => {
        const store = new Store(':memory:')
        store.goalHistory.record('a', { objective: 'repeat me', tokenBudget: 10 })
        store.goalHistory.record('a', { objective: 'something else' })
        const entry = store.goalHistory.record('a', { objective: 'repeat me', tokenBudget: 20 })

        expect(entry?.useCount).toBe(2)
        expect(entry?.tokenBudget).toBe(20)
        const goals = store.goalHistory.list('a')
        expect(goals).toHaveLength(2)
        expect(goals[0]?.objective).toBe('repeat me')
    })

    it('trims blank objectives and deletes entries', () => {
        const store = new Store(':memory:')
        expect(store.goalHistory.record('a', { objective: '   ' })).toBeNull()
        store.goalHistory.record('a', { objective: '  padded goal  ' })

        expect(store.goalHistory.list('a')[0]?.objective).toBe('padded goal')
        expect(store.goalHistory.delete('a', 'padded goal')).toBe(true)
        expect(store.goalHistory.delete('a', 'padded goal')).toBe(false)
        expect(store.goalHistory.list('a')).toHaveLength(0)
    })

    it('keeps at most 50 objectives per namespace', () => {
        const store = new Store(':memory:')
        for (let index = 0; index < 60; index++) {
            store.goalHistory.record('a', { objective: `goal ${index}` })
        }
        expect(store.goalHistory.list('a', 50)).toHaveLength(50)
        expect(store.goalHistory.list('a', 50).some(goal => goal.objective === 'goal 0')).toBe(false)
        expect(store.goalHistory.list('a', 50)[0]?.objective).toBe('goal 59')
    })
})
