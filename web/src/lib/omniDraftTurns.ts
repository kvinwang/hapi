type SpeechTurn = { itemId?: string; transcript?: string; finished: boolean; handled: boolean; command?: boolean; draftBefore: string }

/** Join independently arriving ASR and response events without duplicating tool-produced drafts. */
export class OmniDraftTurns {
    private turns: SpeechTurn[] = []
    private responses = new Map<string, SpeechTurn>()
    private current?: SpeechTurn

    start(itemId?: string, draftBefore = '') {
        const turn = { itemId, finished: false, handled: false, draftBefore }
        this.turns.push(turn)
        this.turns = this.turns.slice(-64)
    }

    response(responseId?: string) {
        if (responseId && this.responses.has(responseId)) {
            this.current = this.responses.get(responseId)
            return
        }
        this.current = this.turns.find((turn) => !turn.finished && ![...this.responses.values()].includes(turn))
        if (responseId && this.current) this.responses.set(responseId, this.current)
        if (this.responses.size > 64) this.responses.delete(this.responses.keys().next().value!)
    }

    isHandled(itemId: string): boolean {
        return this.turns.find((turn) => turn.itemId === itemId)?.handled ?? false
    }

    command(itemId: string): string | undefined {
        const turn = this.turns.find((entry) => entry.itemId === itemId)
        if (!turn || turn.command) return
        turn.command = true
        turn.handled = true
        return turn.draftBefore
    }

    isCommand(responseId?: string): boolean {
        return Boolean((responseId ? this.responses.get(responseId) : this.current)?.command)
    }

    itemId(responseId?: string): string | undefined {
        return (responseId ? this.responses.get(responseId) : this.current)?.itemId
    }

    handled(responseId?: string) {
        const turn = responseId ? this.responses.get(responseId) : this.current ?? this.turns.at(-1)
        if (turn) turn.handled = true
    }

    transcript(itemId: string, text: string): string | undefined {
        const turn = this.turns.find((entry) => entry.itemId === itemId)
        if (!turn) return
        turn.transcript = text.trim()
        return this.fallback(turn)
    }

    finish(responseId?: string): string | undefined {
        const turn = responseId ? this.responses.get(responseId) : this.current ?? this.turns.at(-1)
        if (!turn) return
        turn.finished = true
        return this.fallback(turn)
    }

    clear() {
        this.turns = []
        this.responses.clear()
        this.current = undefined
    }

    private fallback(turn: SpeechTurn): string | undefined {
        if (!turn.finished || turn.handled || !turn.transcript) return
        turn.handled = true
        return turn.transcript
    }
}
