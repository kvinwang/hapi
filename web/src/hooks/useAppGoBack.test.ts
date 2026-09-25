import { describe, expect, it } from 'vitest'
import { settingsParentPath } from './useAppGoBack'

describe('settingsParentPath', () => {
    it.each([
        ['/settings', '/sessions'],
        ['/settings/', '/sessions'],
        ['/settings/general', '/settings'],
        ['/settings/models/providers', '/settings/models'],
        ['/settings/devices/add', '/settings/devices'],
    ])('%s goes back to %s', (pathname, parent) => {
        expect(settingsParentPath(pathname)).toBe(parent)
    })

    it('ignores non-settings paths', () => {
        expect(settingsParentPath('/sessions/abc')).toBeNull()
        expect(settingsParentPath('/settingsx')).toBeNull()
    })
})
