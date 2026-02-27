const USER_MESSAGE_DOM_ID_PREFIX = 'user-message-'

export function buildUserMessageDomId(messageId: string): string {
    return `${USER_MESSAGE_DOM_ID_PREFIX}${messageId}`
}
