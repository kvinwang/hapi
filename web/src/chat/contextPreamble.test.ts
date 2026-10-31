import { describe, expect, it } from 'vitest'
import { splitContextPreamble } from './contextPreamble'

describe('splitContextPreamble', () => {
    it('splits a single context line', () => {
        expect(splitContextPreamble('[电脑#20 10:24 Sat]\n收起控制中心')).toEqual({
            label: '电脑#20 10:24 Sat',
            preamble: '[电脑#20 10:24 Sat]',
            body: '收起控制中心'
        })
    })

    it('runs through the last bracket line', () => {
        const text = '[电脑#20]\n[此前车内对话]\n10:24 the\n[用户对你说]\n扫一下二维码'
        expect(splitContextPreamble(text)).toMatchObject({
            preamble: '[电脑#20]\n[此前车内对话]\n10:24 the\n[用户对你说]',
            body: '扫一下二维码'
        })
    })

    it('ignores plain messages and bracket-only messages', () => {
        expect(splitContextPreamble('[link](https://x) hi')).toBeNull()
        expect(splitContextPreamble('[only context]')).toBeNull()
    })
})
