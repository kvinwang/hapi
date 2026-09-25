import { createContext, useContext, type ReactNode } from 'react'
import { useAppearance } from '@/hooks/useTheme'
import { useChatPageSize } from '@/hooks/useChatPageSize'

type SettingsState = ReturnType<typeof useAppearance> & ReturnType<typeof useChatPageSize>

const SettingsStateContext = createContext<SettingsState | null>(null)

/**
 * One instance of the locally stored preferences that the category summaries
 * echo. Separate hook instances would leave the desktop nav showing stale values.
 */
export function SettingsStateProvider(props: { children: ReactNode }) {
    const appearance = useAppearance()
    const chatPageSize = useChatPageSize()
    return (
        <SettingsStateContext.Provider value={{ ...appearance, ...chatPageSize }}>
            {props.children}
        </SettingsStateContext.Provider>
    )
}

export function useSettingsState(): SettingsState {
    const value = useContext(SettingsStateContext)
    if (!value) throw new Error('useSettingsState must be used inside SettingsStateProvider')
    return value
}
