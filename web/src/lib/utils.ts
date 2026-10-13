import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
    return twMerge(clsx(inputs))
}

export function formatElapsedDuration(elapsedSeconds: number): string {
    const seconds = Math.max(0, Math.floor(elapsedSeconds))
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`
    const hours = Math.floor(minutes / 60)
    return `${hours}h ${minutes % 60}m`
}

/**
 * Decode base64 string to UTF-8 text
 */
export function decodeBase64(value: string): { text: string; ok: boolean } {
    try {
        const binaryString = atob(value)
        const bytes = Uint8Array.from(binaryString, (char) => char.charCodeAt(0))
        const text = new TextDecoder('utf-8').decode(bytes)
        return { text, ok: true }
    } catch {
        return { text: '', ok: false }
    }
}

/**
 * Encode UTF-8 text to base64 string
 */
export function encodeBase64(value: string): string {
    const bytes = new TextEncoder().encode(value)
    const binaryString = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')
    return btoa(binaryString)
}

