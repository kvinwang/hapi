import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import { QuickPhraseButton } from './QuickPhraseButton'

afterEach(cleanup)
it('shows a save failure without falsely marking the phrase saved, and allows retry', async () => {
    const updatePreferences = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockImplementation(async patch => patch)
    const api = { getPreferences: async () => ({ quickPhrases: [] }), updatePreferences } as unknown as ApiClient
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    render(<QueryClientProvider client={client}><I18nProvider><QuickPhraseButton api={api} text="Reusable text" /></I18nProvider></QueryClientProvider>)
    const button = screen.getByRole('button', { name: 'Save as quick phrase' })
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(button).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(button)
    expect(await screen.findByRole('button', { name: 'Remove from quick phrases' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('alert')).toBeNull()
    client.clear()
})
