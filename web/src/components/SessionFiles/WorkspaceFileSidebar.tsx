import { useCallback, useMemo } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { useSession } from '@/hooks/queries/useSession'
import { encodeBase64 } from '@/lib/utils'
import { FileExplorerPane } from './FileExplorerPane'

export function WorkspaceFileSidebar(props: {
    sessionId: string
    className?: string
    onAfterOpenFile?: () => void
    headerActions?: React.ReactNode
}) {
    const { api } = useAppContext()
    const navigate = useNavigate()
    const { session } = useSession(api, props.sessionId)

    const cwd = session?.metadata?.path
    const rootLabel = useMemo(() => {
        const base = cwd ?? props.sessionId
        const parts = base.split(/[/\\]/).filter(Boolean)
        return parts.length ? parts[parts.length - 1] : base
    }, [cwd, props.sessionId])

    const handleOpenFile = useCallback(
        (path: string) => {
            navigate({
                to: '/sessions/$sessionId/file',
                params: { sessionId: props.sessionId },
                search: { path: encodeBase64(path) }
            })
            props.onAfterOpenFile?.()
        },
        [navigate, props]
    )

    return (
        <FileExplorerPane
            api={api}
            sessionId={props.sessionId}
            rootLabel={rootLabel}
            cwd={cwd}
            onOpenFile={handleOpenFile}
            className={props.className}
            headerActions={props.headerActions}
        />
    )
}
