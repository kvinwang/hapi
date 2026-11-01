import { describe, expect, it } from 'vitest'
import { voiceDraftCommand } from './voiceDraftCommand'

describe('standalone voice draft commands', () => {
    it.each(['发送', '发送吧。', '发出去', '发送当前草稿'])('recognizes send: %s', (text) => {
        expect(voiceDraftCommand(text)).toBe('send')
    })
    it.each(['算了', '取消', '算了，不发了。', '取消草稿', '清掉草稿', '清空当前草稿'])('recognizes cancel: %s', (text) => {
        expect(voiceDraftCommand(text)).toBe('clear')
    })
    it.each(['等等', '等一下。', '编辑一下', '我编辑一下', '暂停自动发送'])('pauses only this round: %s', (text) => {
        expect(voiceDraftCommand(text)).toBe('pause')
    })
    it.each(['加入草稿', '我让你加入草稿。', '把刚才那句发给 AI'])('includes pending speech: %s', (text) => {
        expect(voiceDraftCommand(text)).toBe('include')
    })
    it.each(['我说“发送”时应该发出去', '发送功能有问题', '不要发送', '他说算了不发了', '“发送”', '我没跟你说这个', '我说等等时要暂停', '他说编辑一下', '“加入草稿”'])('keeps content: %s', (text) => {
        expect(voiceDraftCommand(text)).toBeNull()
    })
})
