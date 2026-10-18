import { createContext, useContext, type ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import type { GuestInfo } from '@/types/api'

type AppContextValue = {
    api: ApiClient
    token: string
    baseUrl: string
    logout?: () => void
    /** Set when a guest is restricted to a single session. */
    guest?: GuestInfo
}

const AppContext = createContext<AppContextValue | null>(null)

export function AppContextProvider(props: {
    value: AppContextValue
    children: ReactNode
}) {
    return (
        <AppContext.Provider value={props.value}>
            {props.children}
        </AppContext.Provider>
    )
}

export function useAppContext(): AppContextValue {
    const context = useContext(AppContext)
    if (!context) {
        throw new Error('AppContext is not available')
    }
    return context
}

export function useOptionalAppContext(): AppContextValue | null {
    return useContext(AppContext)
}
