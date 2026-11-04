import type { Socket } from 'socket.io-client'

// Socket.IO only retries transport failures, not middleware rejections.
export function retrySocketAuthentication(socket: Socket): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined
    const clear = () => {
        clearTimeout(timer)
        timer = undefined
    }
    const retry = () => {
        if (socket.active || timer) return
        timer = setTimeout(() => {
            timer = undefined
            if (!socket.connected && !socket.active) socket.connect()
        }, 5_000)
    }
    socket.on('connect_error', retry)
    socket.on('connect', clear)
    return () => {
        clear()
        socket.off('connect_error', retry)
        socket.off('connect', clear)
    }
}
