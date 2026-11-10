import { describe, expect, it } from 'vitest'
import { isNavigationPrompt } from './navigationPrompt'

describe('isNavigationPrompt', () => {
    it.each([
        '前方三百米右转，然后进入匝道。',
        '前方有测速拍照，限速80',
        '您已超速',
        '已为您重新规划路线',
        '沿当前道路继续行驶2公里',
        '进入隧道，请减速慢行',
        '目的地在您的右侧',
        'In 500 feet, turn right onto Main Street.',
        'You have arrived at your destination.',
    ])('ignores %s', (text) => expect(isNavigationPrompt(text)).toBe(true))

    it.each([
        '继续',
        '进入代码目录',
        '重新规划一下这个任务',
        '把限速逻辑改一下',
        '前方300米右转帮我看一下测试',
        'turn on dark mode',
    ])('keeps %s', (text) => expect(isNavigationPrompt(text)).toBe(false))
})
