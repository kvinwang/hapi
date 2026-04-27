import * as DialogPrimitive from '@radix-ui/react-dialog'
import { WorkspaceFileSidebar } from './WorkspaceFileSidebar'

function CloseIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
    )
}

interface MobileFileSidebarProps {
    sessionId: string
    open: boolean
    onOpenChange: (open: boolean) => void
}

export function MobileFileSidebar(props: MobileFileSidebarProps) {
    return (
        <DialogPrimitive.Root open={props.open} onOpenChange={props.onOpenChange}>
            <DialogPrimitive.Portal>
                <DialogPrimitive.Overlay className="hapi-drawer-overlay fixed inset-0 z-40 bg-black/50" />
                <DialogPrimitive.Content
                    className="hapi-drawer-content fixed inset-y-0 right-0 z-50 flex w-[85vw] max-w-sm flex-col bg-surface-0 shadow-2xl outline-none"
                >
                    <DialogPrimitive.Title className="sr-only">Files</DialogPrimitive.Title>
                    <WorkspaceFileSidebar
                        sessionId={props.sessionId}
                        className="flex-1"
                        onAfterOpenFile={() => props.onOpenChange(false)}
                        headerActions={
                            <DialogPrimitive.Close asChild>
                                <button
                                    type="button"
                                    className="rounded p-1 text-foreground-muted hover:bg-surface-2 hover:text-foreground transition-colors"
                                    aria-label="Close"
                                >
                                    <CloseIcon />
                                </button>
                            </DialogPrimitive.Close>
                        }
                    />
                </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
    )
}
