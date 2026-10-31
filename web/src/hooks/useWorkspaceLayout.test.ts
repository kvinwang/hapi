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
        expect(resolveWorkspaceLayout({ wide, spacious, finePointer })).toMatchObject({
            fileSidebar: 'drawer',
            sessionSidebar: 'drawer',
            subagentView: 'page',
            composer: 'docked',
        })
    })

    it('uses only the file sidebar on a medium mouse-driven viewport', () => {
        expect(resolveWorkspaceLayout({ wide: true, spacious: false, finePointer: true })).toEqual({
            fileSidebar: 'persistent',
            sessionSidebar: 'drawer',
            settingsNav: 'persistent',
            subagentView: 'panel',
            composer: 'inline',
        })
    })

    it('uses persistent sidebars on a spacious mouse-driven viewport', () => {
        expect(resolveWorkspaceLayout({ wide: true, spacious: true, finePointer: true })).toEqual({
            fileSidebar: 'persistent',
            sessionSidebar: 'persistent',
            settingsNav: 'persistent',
            subagentView: 'panel',
            composer: 'inline',
        })
    })

    it('drills down through settings on narrow viewports, even with a mouse', () => {
        expect(resolveWorkspaceLayout({ wide: false, spacious: false, finePointer: true }).settingsNav).toBe('drilldown')
        expect(resolveWorkspaceLayout({ wide: true, spacious: false, finePointer: false }).settingsNav).toBe('persistent')
    })
})
