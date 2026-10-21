import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { ProviderModelPicker } from './ProviderModelPicker'

function fixture(options: { fail?: boolean; disabled?: boolean; busy?: boolean } = {}) {
    const getSessionProviders = vi.fn().mockResolvedValue({ providers: [{ provider: { source: 'credential', credentialId: 'a' }, name: 'Provider A', model: 'model-a' }, { provider: { source: 'credential', credentialId: 'a' }, name: 'Provider A', model: 'model-a2' }, { provider: { source: 'profile', profile: 'redpill' }, name: 'redpill', model: 'profile-model' }, { provider: { source: 'credential', credentialId: 'b' }, name: 'Provider B', model: 'model-b' }] })
    const setSessionProvider = options.fail ? vi.fn().mockRejectedValue(new Error('Switch failed')) : vi.fn().mockResolvedValue({ ok: true })
    const onModelChange = vi.fn()
    const api = { getSessionProviders, setSessionProvider } as unknown as ApiClient
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ProviderModelPicker api={api} sessionId="s1" provider={{ provider: { source: 'credential', credentialId: 'a' }, name: 'Provider A' }} model="model-a"
            models={[{ mode: 'model-a', label: 'Model A' }, { mode: 'model-a2', label: 'Model A2' }]}
            disabled={options.disabled ?? false} providerSwitchDisabled={options.busy ?? false} onModelChange={onModelChange} />
    </QueryClientProvider>)
    return { setSessionProvider, onModelChange }
}

function selectProvider(value: unknown) {
    fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), { target: { value: JSON.stringify(value) } })
}

afterEach(cleanup)

describe('ProviderModelPicker', () => {
    it('switches provider with its first model', async () => {
        const { setSessionProvider } = fixture()
        await screen.findByRole('option', { name: 'Provider B' })
        selectProvider({ source: 'credential', credentialId: 'b' })
        await waitFor(() => expect(setSessionProvider).toHaveBeenCalledWith('s1', { source: 'credential', credentialId: 'b' }, 'model-b'))
    })
    it('submits a native profile reference without uploading its configuration', async () => {
        const { setSessionProvider } = fixture()
        await screen.findByRole('option', { name: 'redpill' })
        selectProvider({ source: 'profile', profile: 'redpill' })
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
        expect((screen.getByRole('combobox', { name: 'Provider' }) as HTMLSelectElement).value)
            .toBe(JSON.stringify({ source: 'credential', credentialId: 'redpill-db' }))
        await screen.findByRole('option', { name: 'redpill (Local profile)' })
        fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), {
            target: { value: JSON.stringify({ source: 'profile', profile: 'redpill' }) }
        })
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
    it('uses ordinary model changes when the provider is unchanged', async () => {
        const { setSessionProvider, onModelChange } = fixture()
        await screen.findByRole('option', { name: 'model-a2' })
        fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: 'model-a2' } })
        expect(onModelChange).toHaveBeenCalledWith('model-a2')
        expect(setSessionProvider).not.toHaveBeenCalled()
    })
    it('restores machine defaults with a null credential ID', async () => {
        const { setSessionProvider } = fixture()
        selectProvider({ source: 'default' })
        await waitFor(() => expect(setSessionProvider).toHaveBeenCalledWith('s1', { source: 'default' }, 'auto'))
    })
    it('shows switch failures without claiming success', async () => {
        fixture({ fail: true })
        await screen.findByRole('option', { name: 'Provider B' })
        selectProvider({ source: 'credential', credentialId: 'b' })
        expect(await screen.findByRole('alert')).toHaveTextContent('Switch failed')
        expect((screen.getByRole('combobox', { name: 'Provider' }) as HTMLSelectElement).value)
            .toBe(JSON.stringify({ source: 'credential', credentialId: 'a' }))
    })
    it('keeps ordinary model changes available while provider switching is blocked', async () => {
        const { onModelChange, setSessionProvider } = fixture({ busy: true })
        expect(screen.getByRole('combobox', { name: 'Provider' })).toBeDisabled()
        await screen.findByRole('option', { name: 'model-a2' })
        fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: 'model-a2' } })
        expect(onModelChange).toHaveBeenCalledWith('model-a2')
        expect(setSessionProvider).not.toHaveBeenCalled()
    })
    it('disables changes while the session is busy or locally controlled', async () => {
        const { setSessionProvider } = fixture({ disabled: true })
        expect(screen.getByRole('combobox', { name: 'Provider' })).toBeDisabled()
        expect(screen.getByRole('combobox', { name: 'Model' })).toBeDisabled()
        expect(setSessionProvider).not.toHaveBeenCalled()
    })
})
