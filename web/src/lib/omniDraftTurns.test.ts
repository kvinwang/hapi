import { describe, expect, it } from 'vitest'
import { OmniDraftTurns } from './omniDraftTurns'

describe('Omni draft transcription fallback', () => {
    it('retains quoted control-like speech when the model returns no draft', () => {
        const turns = new OmniDraftTurns()
        turns.start('speech-1')
        turns.stop('speech-1')
        turns.response('response-1')
        expect(turns.transcript('speech-1', '我没跟你说这个')).toBeUndefined()
        expect(turns.finish('response-1')).toBe('我没跟你说这个')
        expect(turns.finish('response-1')).toBeUndefined()
    })

    it('accepts transcription after response completion exactly once', () => {
        const turns = new OmniDraftTurns()
        turns.start('speech-1')
        turns.stop('speech-1')
        turns.response('response-1')
        expect(turns.finish('response-1')).toBeUndefined()
        expect(turns.transcript('speech-1', 'Late words')).toBe('Late words')
        expect(turns.transcript('speech-1', 'Late words')).toBeUndefined()
    })

    it('does not duplicate a valid tool draft or an intentional clear', () => {
        const turns = new OmniDraftTurns()
        turns.start('speech-1')
        turns.stop('speech-1')
        turns.response('response-1')
        turns.handled('response-1')
        turns.transcript('speech-1', 'Clear the current draft')
        expect(turns.finish('response-1')).toBeUndefined()
    })

    it('matches overlapping speech by item and response ids', () => {
        const turns = new OmniDraftTurns()
        turns.start('first')
        turns.stop('first')
        turns.response('r1')
        turns.start('second')
        turns.stop('second')
        turns.response('r2')
        turns.transcript('first', 'First sentence')
        turns.transcript('second', 'Second sentence')
        turns.handled('r2')
        expect(turns.finish('r1')).toBe('First sentence')
        expect(turns.finish('r2')).toBeUndefined()
    })

    it('does not restore text after clear, send, or reconnect', () => {
        const turns = new OmniDraftTurns()
        turns.start('speech-1')
        turns.stop('speech-1')
        turns.response('response-1')
        turns.finish('response-1')
        turns.clear()
        expect(turns.transcript('speech-1', 'Old text')).toBeUndefined()
    })

    it('does not shift later responses when multiple VAD segments share one model response', () => {
        const turns = new OmniDraftTurns()
        turns.start('short')
        turns.stop('short')
        turns.transcript('short', 'Hello')
        // No response is emitted for the short segment.
        turns.start('first')
        turns.stop('first')
        turns.transcript('first', 'First requirement')
        turns.response('r1')
        turns.handled('r1')
        expect(turns.finish('r1')).toBeUndefined()
        expect(turns.hasPending()).toBe(false)
        turns.start('second')
        turns.stop('second')
        turns.transcript('second', 'Second requirement')
        turns.response('r2')
        // The current ASR fallback must not be the previous requirement.
        expect(turns.finish('r2')).toBe('Second requirement')
        expect(turns.hasPending()).toBe(false)
    })

    it('does not assign speech that is still being spoken to an older response', () => {
        const turns = new OmniDraftTurns()
        turns.start('first')
        turns.stop('first')
        turns.start('second')
        turns.response('r1')
        turns.handled('r1')
        turns.finish('r1')
        expect(turns.isHandled('second')).toBe(false)
        expect(turns.hasPending()).toBe(true)
        turns.stop('second')
        turns.response('r2')
        expect(turns.itemId('r2')).toBe('second')
    })

})
