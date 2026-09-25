import { useCallback } from 'react'
import { useLocation, useNavigate, useRouter } from '@tanstack/react-router'

/** Logical parent of a settings page: one level up, and out to sessions from the top. */
export function settingsParentPath(pathname: string): string | null {
    const trimmed = pathname.replace(/\/+$/, '')
    if (trimmed === '/settings') return '/sessions'
    if (!trimmed.startsWith('/settings/')) return null
    return trimmed.replace(/\/[^/]+$/, '')
}

export function useAppGoBack(): () => void {
    const navigate = useNavigate()
    const router = useRouter()
    const pathname = useLocation({ select: (location) => location.pathname })
    const search = useLocation({ select: (location) => location.search })

    return useCallback(() => {
        // Use explicit path navigation for consistent behavior across all environments
        if (pathname === '/sessions/new') {
            navigate({ to: '/sessions' })
            return
        }

        const settingsParent = settingsParentPath(pathname)
        if (settingsParent) {
            navigate({ to: settingsParent })
            return
        }

        // For single file view, go back to files list
        if (pathname.match(/^\/sessions\/[^/]+\/file$/)) {
            const filesPath = pathname.replace(/\/file$/, '/files')

            const tab = (search && typeof search === 'object' && 'tab' in search)
                ? (search as { tab?: unknown }).tab
                : undefined
            const nextSearch = tab === 'directories' ? { tab: 'directories' as const } : {}

            navigate({ to: filesPath, search: nextSearch })
            return
        }

        // For session routes, navigate to parent path
        if (pathname.startsWith('/sessions/')) {
            const parentPath = pathname.replace(/\/[^/]+$/, '') || '/sessions'
            navigate({ to: parentPath })
            return
        }

        // Fallback to history.back() for other cases
        router.history.back()
    }, [navigate, pathname, router, search])
}
