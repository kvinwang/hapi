/** Only a standalone utterance controls delivery; quoted or embedded words remain draft content. */
export function voiceDraftCommand(text: string): 'send' | 'clear' | 'include' | 'pause' | null {
    const command = text.trim().replace(/[\s，。！？、,.!?]/g, '')
    if (['发送', '发送吧', '发出去', '发送草稿', '发送当前草稿', '把草稿发出去'].includes(command)) return 'send'
    if (['算了', '取消', '不发了', '算了不发了', '取消草稿', '清掉草稿', '清空草稿', '清空当前草稿', '把草稿清掉'].includes(command)) return 'clear'
    if (['加入草稿', '加入到草稿', '加入草稿吧', '我让你加入草稿', '把这句加入草稿', '把这段加入草稿', '把刚才那句加入草稿', '把刚才那句发给AI'].includes(command)) return 'include'
    if (['等等', '等一下', '等一等', '先等等', '先别发', '先不要发', '暂停发送', '暂停自动发送', '编辑一下', '我编辑一下', '让我编辑一下'].includes(command)) return 'pause'
    return null
}
