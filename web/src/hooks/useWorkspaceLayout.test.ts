import { describe, expect, it } from 'vitest'
import { resolveWorkspaceLayout } from './useWorkspaceLayout'

describe('workspace layout', () => {
    it.each([
        ['phone portrait', false, false, false],
        ['phone landscape', false, false, false],
        ['iPad portrait', false, false, false],
        ['iPad landscape', true, false, false],
        ['touchscreen desktop', true, true, false],
    ])('uses drawers on %s', (_name, wide, spacious, finePointer) => {
        expect(resolveWorkspaceLayout({ wide, spacious, finePointer })).toEqual({
            fileSidebar: 'drawer',
            sessionSidebar: 'drawer',
        })
    })

    it('uses only the file sidebar on a medium mouse-driven viewport', () => {
        expect(resolveWorkspaceLayout({ wide: true, spacious: false, finePointer: true })).toEqual({
            fileSidebar: 'persistent',
            sessionSidebar: 'drawer',
        })
    })

    it('uses persistent sidebars on a spacious mouse-driven viewport', () => {
        expect(resolveWorkspaceLayout({ wide: true, spacious: true, finePointer: true })).toEqual({
            fileSidebar: 'persistent',
            sessionSidebar: 'persistent',
        })
    })
})
