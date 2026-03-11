/**
 * Uplink protocol: Relay (local) ↔ Hub communication.
 * JSON messages over SSE (down) + HTTP POST (up).
 */

// --- Relay → Hub ---

export interface UplinkInbound {
    type: 'inbound'
    text: string
    senderId: string
}

export interface UplinkToolResult {
    type: 'tool_result'
    id: string
    result: unknown
    error?: string
}

export interface UplinkHello {
    type: 'hello'
    version: string
    speakerConnected: boolean
}

export interface UplinkStatus {
    type: 'status'
    speakerConnected: boolean
}

export type UplinkUp = UplinkInbound | UplinkToolResult | UplinkHello | UplinkStatus

// --- Hub → Relay ---

export interface UplinkOutbound {
    type: 'outbound'
    text: string
}

export interface UplinkToolCall {
    type: 'tool_call'
    id: string
    name: string
    params: Record<string, unknown>
}

export interface UplinkAck {
    type: 'ack'
}

export type UplinkDown = UplinkOutbound | UplinkToolCall | UplinkAck
