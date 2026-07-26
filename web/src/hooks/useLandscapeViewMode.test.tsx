import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useLandscapeViewMode } from './useLandscapeViewMode'

type Query = { matches: boolean; listeners: Set<() => void> }

const queries = new Map<string, Query>()

function setQuery(query: string, matches: boolean) {
    const entry = queries.get(query) ?? { matches, listeners: new Set<() => void>() }
    entry.matches = matches
    queries.set(query, entry)
}

function fire(query: string, matches: boolean) {
    setQuery(query, matches)
    for (const listener of queries.get(query)!.listeners) listener()
}

beforeEach(() => {
    queries.clear()
    setQuery('(pointer: coarse)', true)
    setQuery('(orientation: landscape)', false)
    setQuery('(max-height: 500px)', false)
    Object.defineProperty(window, 'matchMedia', {
        writable: true,
        value: (query: string) => {
            const entry = queries.get(query) ?? { matches: false, listeners: new Set<() => void>() }
            queries.set(query, entry)
            return {
                get matches() { return entry.matches },
                addEventListener: (_: string, listener: () => void) => entry.listeners.add(listener),
                removeEventListener: (_: string, listener: () => void) => entry.listeners.delete(listener)
            }
        }
    })
})

describe('landscape view mode', () => {
    it('enters view mode when a handset turns sideways and leaves when it turns back', () => {
        const setViewMode = vi.fn()
        renderHook(() => useLandscapeViewMode(true, setViewMode))
        expect(setViewMode).not.toHaveBeenCalled()

        setQuery('(max-height: 500px)', true)
        fire('(orientation: landscape)', true)
        expect(setViewMode).toHaveBeenLastCalledWith(true)

        setQuery('(max-height: 500px)', false)
        fire('(orientation: landscape)', false)
        expect(setViewMode).toHaveBeenLastCalledWith(false)
    })

    it('leaves a tall device alone, sideways or not', () => {
        const setViewMode = vi.fn()
        renderHook(() => useLandscapeViewMode(true, setViewMode))

        // A tablet in landscape still has room for the composer.
        fire('(orientation: landscape)', true)
        expect(setViewMode).not.toHaveBeenCalled()
    })

    it('leaves a mouse-driven window alone', () => {
        setQuery('(pointer: coarse)', false)
        setQuery('(max-height: 500px)', true)
        const setViewMode = vi.fn()
        renderHook(() => useLandscapeViewMode(true, setViewMode))

        fire('(orientation: landscape)', true)
        expect(setViewMode).not.toHaveBeenCalled()
    })
})
