/** Only a standalone utterance controls delivery; quoted or embedded words remain draft content. */
export function voiceDraftCommand(text: string): 'send' | 'clear' | null {
    const command = text.trim().replace(/[\s，。！？、,.!?]/g, '')
    if (['发送', '发送吧', '发出去', '发送草稿', '发送当前草稿', '把草稿发出去'].includes(command)) return 'send'
    if (['算了', '取消', '不发了', '算了不发了', '取消草稿', '清掉草稿', '清空草稿', '清空当前草稿', '把草稿清掉'].includes(command)) return 'clear'
    return null
}
