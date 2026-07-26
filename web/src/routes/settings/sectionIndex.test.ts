import { describe, expect, it } from 'vitest'
import { activeSectionId } from './sectionIndex'

const sections = [
    { id: 'appearance', offsetTop: 0 },
    { id: 'chat', offsetTop: 400 },
    { id: 'voice', offsetTop: 900 }
]

describe('settings section index', () => {
    it('starts on the first group', () => {
        expect(activeSectionId(sections, 0, 40)).toBe('appearance')
    })

    it('moves on once a heading docks under the sticky bar', () => {
        expect(activeSectionId(sections, 350, 40)).toBe('appearance')
        expect(activeSectionId(sections, 360, 40)).toBe('chat')
    })

    it('holds the last group at the bottom of the page', () => {
        expect(activeSectionId(sections, 5_000, 40)).toBe('voice')
    })

    it('has nothing to highlight without sections', () => {
        expect(activeSectionId([], 0, 40)).toBeNull()
    })
})
