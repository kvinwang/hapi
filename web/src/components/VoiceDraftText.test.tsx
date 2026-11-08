import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { VoiceDraftText } from './VoiceDraftText'

const { copy } = vi.hoisted(() => ({ copy: vi.fn() }))
vi.mock('@/hooks/useCopyToClipboard', () => ({ useCopyToClipboard: () => ({ copied: false, copy }) }))

vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(cleanup)

function Editor({ text, start = vi.fn() }: { text: string; start?: () => void }) {
    const [value, setValue] = useState(text)
    return <VoiceDraftText value={value} onChange={setValue} onEditStart={start} />
}

function select(start: number, end = start) {
    const first = document.querySelector(`[data-draft-start="${start}"]`)!
    const last = document.querySelector(`[data-draft-start="${end}"]`)!
    fireEvent.pointerDown(first, { pointerId: 1 })
    fireEvent.pointerMove(last, { pointerId: 1 })
    fireEvent.pointerUp(last, { pointerId: 1 })
}

it('starts as text, accumulates disjoint selections and deletes them together', () => {
    const start = vi.fn()
    render(<Editor text="abcdef" start={start} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    select(0, 1)
    select(4, 5)
    fireEvent.click(screen.getByRole('button', { name: 'voice.omni.draft.deleteSelected' }))
    expect(screen.getByRole('group')).toHaveTextContent('cd')
    expect(start).toHaveBeenCalledTimes(2)
})

it('merges overlapping selections without deleting unselected text', () => {
    render(<Editor text="abcdef" />)
    select(1, 3)
    select(2, 4)
    fireEvent.click(screen.getByRole('button', { name: 'voice.omni.draft.deleteSelected' }))
    expect(screen.getByRole('group')).toHaveTextContent('af')
})

it('selects complete emoji graphemes and leaves neighboring text intact', () => {
    render(<Editor text="A👨‍👩‍👧‍👦B" />)
    select(1)
    fireEvent.click(screen.getByRole('button', { name: 'voice.omni.draft.deleteSelected' }))
    expect(screen.getByRole('group')).toHaveTextContent('AB')
})

it('uses a text input only after the edit button is clicked', () => {
    render(<Editor text="Draft" />)
    fireEvent.click(screen.getByRole('button', { name: 'voice.omni.draft.edit' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Edited draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'voice.omni.draft.doneEditing' }))
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByRole('group')).toHaveTextContent('Edited draft')
})

it('releases the editing pause if the first selection gesture is canceled', () => {
    const end = vi.fn()
    render(<VoiceDraftText value="Draft" onChange={vi.fn()} onEditEnd={end} />)
    const first = document.querySelector('[data-draft-start="0"]')!
    fireEvent.pointerDown(first, { pointerId: 1 })
    fireEvent.pointerCancel(first, { pointerId: 1 })
    expect(end).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'voice.omni.draft.deleteSelected' })).not.toBeInTheDocument()
})


it('copies the full current draft after editing without clearing it', async () => {
    render(<Editor text="Original draft" />)
    fireEvent.click(screen.getByRole('button', { name: 'voice.omni.draft.edit' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Edited draft\nSecond line' } })
    fireEvent.click(screen.getByRole('button', { name: 'button.copy' }))
    await waitFor(() => expect(copy).toHaveBeenCalledWith('Edited draft\nSecond line'))
    expect(screen.getByRole('textbox')).toHaveValue('Edited draft\nSecond line')
})

it('offers copying in read-only mode and disables it for an empty draft', () => {
    const { rerender } = render(<VoiceDraftText value="Read-only draft" />)
    fireEvent.click(screen.getByRole('button', { name: 'button.copy' }))
    expect(copy).toHaveBeenCalledWith('Read-only draft')
    rerender(<VoiceDraftText value="" />)
    expect(screen.getByRole('button', { name: 'button.copy' })).toBeDisabled()
})
