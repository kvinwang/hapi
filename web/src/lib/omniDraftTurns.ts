type SpeechTurn = { itemId?: string; transcript?: string; stopped: boolean; finished: boolean; handled: boolean; command?: boolean; draftBefore: string }

/** A response may cover several VAD segments: do not assume one response per speech start. */
export class OmniDraftTurns {
    private turns: SpeechTurn[] = []
    private responses = new Map<string, SpeechTurn[]>()
    private current: SpeechTurn[] = []

    start(itemId?: string, draftBefore = '') {
        if (itemId && this.turns.some((turn) => turn.itemId === itemId)) return
        this.turns.push({ itemId, stopped: false, finished: false, handled: false, draftBefore })
        this.turns = this.turns.slice(-64)
    }

    stop(itemId?: string) {
        const turn = itemId ? this.turns.find((entry) => entry.itemId === itemId) : this.turns.at(-1)
        if (turn) turn.stopped = true
    }

    response(responseId?: string) {
        if (responseId && this.responses.has(responseId)) {
            this.current = this.responses.get(responseId)!
            return
        }
        const assigned = new Set([...this.responses.values()].flat())
        this.current = this.turns.filter((turn) => turn.stopped && !turn.finished && !assigned.has(turn))
        if (responseId) this.responses.set(responseId, this.current)
        if (this.responses.size > 64) this.responses.delete(this.responses.keys().next().value!)
    }

    private group(responseId?: string): SpeechTurn[] {
        return responseId ? this.responses.get(responseId) ?? [] : this.current.length ? this.current : this.turns.filter((turn) => turn.stopped && !turn.finished)
    }

    isFinished(itemId: string): boolean {
        return this.turns.find((turn) => turn.itemId === itemId)?.finished ?? false
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
        const group = this.group(responseId)
        return group.length > 0 && group.every((turn) => turn.command)
    }

    itemId(responseId?: string): string | undefined {
        return this.group(responseId).at(-1)?.itemId
    }

    handled(responseId?: string) {
        for (const turn of this.group(responseId)) turn.handled = true
    }

    transcript(itemId: string, text: string): string | undefined {
        const turn = this.turns.find((entry) => entry.itemId === itemId)
        if (!turn) return
        turn.transcript = text.trim()
        return this.fallback(turn)
    }

    finish(responseId?: string): string | undefined {
        const texts: string[] = []
        for (const turn of this.group(responseId)) {
            turn.finished = true
            const text = this.fallback(turn)
            if (text) texts.push(text)
        }
        return texts.length ? texts.join('\n') : undefined
    }

    summary(responseId?: string): { segments: number; transcribed: number; handled: number } {
        const turns = this.group(responseId)
        return { segments: turns.length, transcribed: turns.filter((turn) => turn.transcript).length, handled: turns.filter((turn) => turn.handled).length }
    }

    hasPending(): boolean {
        return this.turns.some((turn) => !turn.finished && !turn.command)
    }

    discard() {
        for (const turn of this.turns) {
            turn.command = true
            turn.handled = true
        }
    }

    clear() {
        this.turns = []
        this.responses.clear()
        this.current = []
    }

    private fallback(turn: SpeechTurn): string | undefined {
        if (!turn.finished || turn.handled || !turn.transcript) return
        turn.handled = true
        return turn.transcript
    }
}
