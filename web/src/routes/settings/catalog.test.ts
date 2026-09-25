import { describe, expect, it } from 'vitest'
import { entryPath, searchSettings } from '@/routes/settings/catalog'

describe('searchSettings', () => {
    it('matches labels in either language and links to the owning page', () => {
        expect(searchSettings('外观').map(entryPath)).toEqual(['/settings/general'])
        expect(searchSettings('api key').map(entryPath)).toContain('/settings/account/keys')
    })

    it('returns nothing for a blank query', () => {
        expect(searchSettings('  ')).toEqual([])
    })
})
