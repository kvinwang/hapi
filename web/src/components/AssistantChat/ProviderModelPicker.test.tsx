import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { ProviderModelPicker } from './ProviderModelPicker'

function fixture(options: { fail?: boolean; disabled?: boolean; busy?: boolean } = {}) {
    const getSessionProviders = vi.fn().mockResolvedValue({ providers: [{ provider: { source: 'profile', profile: 'redpill' }, name: 'redpill', model: 'profile-model' }, { provider: { source: 'credential', credentialId: 'b' }, name: 'Provider B', model: 'model-b' }] })
    const setSessionProvider = options.fail ? vi.fn().mockRejectedValue(new Error('Switch failed')) : vi.fn().mockResolvedValue({ ok: true })
    const onModelChange = vi.fn()
    const api = { getSessionProviders, setSessionProvider } as unknown as ApiClient
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ProviderModelPicker api={api} sessionId="s1" provider={{ provider: { source: 'credential', credentialId: 'a' }, name: 'Provider A' }} model="model-a"
            models={[{ mode: 'model-a', label: 'Model A' }]} disabled={options.disabled ?? false} providerSwitchDisabled={options.busy ?? false} onModelChange={onModelChange} />
    </QueryClientProvider>)
    return { setSessionProvider, onModelChange }
}

afterEach(cleanup)

describe('ProviderModelPicker', () => {
    it('shows provider/model pairs and submits only credential ID plus model', async () => {
        const { setSessionProvider } = fixture()
        fireEvent.click(await screen.findByRole('button', { name: 'Provider B / model-b' }))
        await waitFor(() => expect(setSessionProvider).toHaveBeenCalledWith('s1', { source: 'credential', credentialId: 'b' }, 'model-b'))
    })
    it('submits a native profile reference without uploading its configuration', async () => {
        const { setSessionProvider } = fixture()
        fireEvent.click(await screen.findByRole('button', { name: 'redpill / profile-model' }))
        await waitFor(() => expect(setSessionProvider).toHaveBeenCalledWith('s1', { source: 'profile', profile: 'redpill' }, 'profile-model'))
    })
    it('distinguishes same-name profile and credential choices without merging their authentication', async () => {
        const setSessionProvider = vi.fn().mockResolvedValue({ ok: true })
        const api = {
            getSessionProviders: vi.fn().mockResolvedValue({ providers: [
                { provider: { source: 'profile', profile: 'redpill' }, name: 'redpill', model: 'z-ai/glm-5.3' }
            ] }),
            setSessionProvider
        } as unknown as ApiClient
        render(<QueryClientProvider client={new QueryClient()}>
            <ProviderModelPicker api={api} sessionId="s1"
                provider={{ provider: { source: 'credential', credentialId: 'redpill-db' }, name: 'redpill' }}
                model="z-ai/glm-5.3" models={[{ mode: 'z-ai/glm-5.3', label: 'z-ai/glm-5.3' }]}
                disabled={false} providerSwitchDisabled={false} onModelChange={vi.fn()} />
        </QueryClientProvider>)
        const profile = await screen.findByRole('button', { name: 'redpill / z-ai/glm-5.3 (Local profile)' })
        expect(screen.getByRole('button', { name: 'redpill / z-ai/glm-5.3 (Agent credential)' }))
            .toHaveAttribute('aria-pressed', 'true')
        fireEvent.click(profile)
        await waitFor(() => expect(setSessionProvider).toHaveBeenCalledWith(
            's1', { source: 'profile', profile: 'redpill' }, 'z-ai/glm-5.3'))
    })
    it('allows a custom model ID for the currently selected provider', () => {
        const { onModelChange } = fixture()
        fireEvent.change(screen.getByRole('textbox', { name: 'Custom model' }), { target: { value: 'custom-model' } })
        fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
        expect(onModelChange).toHaveBeenCalledWith('custom-model')
    })
    it('handles Enter in the custom model field without submitting the chat composer', () => {
        const { onModelChange } = fixture()
        const input = screen.getByRole('textbox', { name: 'Custom model' })
        fireEvent.change(input, { target: { value: 'custom-model' } })
        expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false)
        expect(onModelChange).toHaveBeenCalledWith('custom-model')
    })
    it('uses ordinary model changes when the provider is unchanged', () => {
        const { setSessionProvider, onModelChange } = fixture()
        fireEvent.click(screen.getByRole('button', { name: 'Provider A / Model A' }))
        expect(onModelChange).toHaveBeenCalledWith('model-a')
        expect(setSessionProvider).not.toHaveBeenCalled()
    })
    it('restores machine defaults with a null credential ID', async () => {
        const { setSessionProvider } = fixture()
        fireEvent.click(screen.getByRole('button', { name: 'Machine default / Auto' }))
        await waitFor(() => expect(setSessionProvider).toHaveBeenCalledWith('s1', { source: 'default' }, 'auto'))
    })
    it('shows switch failures without claiming success', async () => {
        fixture({ fail: true })
        fireEvent.click(await screen.findByRole('button', { name: 'Provider B / model-b' }))
        expect(await screen.findByRole('alert')).toHaveTextContent('Switch failed')
        expect(screen.getByRole('button', { name: 'Provider A / Model A' })).toHaveAttribute('aria-pressed', 'true')
    })
    it('keeps ordinary model changes available while provider switching is blocked', async () => {
        const { onModelChange, setSessionProvider } = fixture({ busy: true })
        expect(await screen.findByRole('button', { name: 'Provider B / model-b' })).toBeDisabled()
        fireEvent.click(screen.getByRole('button', { name: 'Provider A / Model A' }))
        expect(onModelChange).toHaveBeenCalledWith('model-a')
        expect(setSessionProvider).not.toHaveBeenCalled()
    })
    it('disables changes while the session is busy or locally controlled', async () => {
        const { setSessionProvider } = fixture({ disabled: true })
        const button = await screen.findByRole('button', { name: 'Provider B / model-b' })
        expect(button).toBeDisabled()
        fireEvent.click(button)
        expect(setSessionProvider).not.toHaveBeenCalled()
    })
})
