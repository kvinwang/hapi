import { describe, expect, it } from 'bun:test'
import { speakable } from './voiceText'

describe('speakable', () => {
    it('collapses code, tables and links into spoken placeholders', () => {
        const text = '改好了 `foo.ts`：\n```ts\nconst a = 1\n```\n| a | b |\n|---|---|\n| 1 | 2 |\n见 https://example.com/x'
        expect(speakable(text)).toBe('改好了 foo.ts：\n（一段代码）\n（一张表）\n见 （链接）')
    })
})
