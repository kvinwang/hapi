import { expect, it } from 'vitest'
import { VoiceContextDebug } from './voiceContextDebug'

it('preserves complete latest instructions and tools across partial session updates', () => {
    const debug = new VoiceContextDebug('session')
    debug.record({ type: 'session.update', session: { instructions: 'Old prompt', tools: [{ name: 'update_draft' }] } })
    const full = 'Full prompt\n' + 'Unabridged context '.repeat(2000)
    debug.record({ type: 'session.update', session: { instructions: full } })
    debug.record({ type: 'session.update', session: { turn_detection: { threshold: 0.9 } } })
    expect(debug.snapshot()).toContain(full)
    expect(debug.snapshot()).not.toContain('Old prompt')
    expect(debug.snapshot()).toContain('update_draft')
})

it('captures sent text and function results without recording audio or transport fields', () => {
    const debug = new VoiceContextDebug('session')
    debug.record({ type: 'session.update', session: { instructions: 'Prompt', token: 'EXCLUDED_TOKEN', relayUrl: 'EXCLUDED_URL' } })
    debug.record({ type: 'input_audio_buffer.append', audio: 'EXCLUDED_AUDIO' })
    debug.record({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Correction instruction' }, { type: 'input_audio', audio: 'EXCLUDED_AUDIO' }] } })
    debug.record({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'call', output: '{"saved":true}' } })
    debug.record({ type: 'conversation.item.delete', item_id: 'item' })
    expect(debug.snapshot()).toContain('Correction instruction')
    expect(debug.snapshot()).toContain('function_call_output')
    expect(debug.snapshot()).toContain('conversation.item.delete')
    expect(debug.snapshot()).not.toContain('EXCLUDED_')
    expect(new VoiceContextDebug('another-session').snapshot()).not.toContain('Correction instruction')
})
