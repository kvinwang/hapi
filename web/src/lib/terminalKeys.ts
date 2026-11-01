export const TERMINAL_KEYS = {
    interrupt: { label: 'Ctrl+C', sequence: '\x03', phrases: ['ctrlc', 'controlc', '控制c', '中断命令', '停止命令'] },
    enter: { label: '↵', sequence: '\r', phrases: ['enter', '回车', '按回车', '敲回车'] },
    tab: { label: 'Tab', sequence: '\t', phrases: ['tab', '按tab', '制表键'] },
    escape: { label: 'Esc', sequence: '\x1b', phrases: ['esc', 'escape', '按esc', '退出键'] },
    up: { label: '↑', sequence: '\x1b[A', phrases: ['上箭头', '方向上', '上一条命令'] },
    down: { label: '↓', sequence: '\x1b[B', phrases: ['下箭头', '方向下', '下一条命令'] },
    left: { label: '←', sequence: '\x1b[D', phrases: ['左箭头', '方向左'] },
    right: { label: '→', sequence: '\x1b[C', phrases: ['右箭头', '方向右'] },
    backspace: { label: '⌫', sequence: '\x7f', phrases: ['backspace', '退格', '退格键'] },
    clearScreen: { label: 'Ctrl+L', sequence: '\x0c', phrases: ['ctrll', 'controll', '终端清屏', '清屏'] },
    endInput: { label: 'Ctrl+D', sequence: '\x04', phrases: ['ctrld', 'controld', '发送eof'] }
} as const
export type TerminalKey = keyof typeof TERMINAL_KEYS

export function spokenTerminalKey(text: string): TerminalKey | null {
    const command = text.toLowerCase().trim().replace(/[\s+，。！？、,.!?]/g, '').replace(/^按(?:一下)?/, '')
    for (const key of Object.keys(TERMINAL_KEYS) as TerminalKey[]) {
        if ((TERMINAL_KEYS[key].phrases as readonly string[]).includes(command)) return key
    }
    return null
}
