/**
 * Claude's two "ask the user" tools, parsed for server-side rendering.
 *
 * They look alike and answer completely differently, which is the whole reason this
 * file exists rather than one generic path:
 *
 * - `AskUserQuestion` answers are **flat, keyed by the question's index as a string**.
 *   The CLI maps that index back to the question text to build what Claude expects, so
 *   keying by header or id yields an empty answer set and stalls the turn.
 * - `request_user_input` answers are **nested, keyed by the question's own `id`**, with
 *   the chosen label first and an optional free-text note appended as `user_note: …`.
 *
 * Neither carries `mode`, `allowTools` or `decision` — the agent side ignores them for
 * question tools, and `mode` would silently change the session's permission mode.
 */

import { isObject } from '@hapi/protocol'

export type ChoiceOption = { label: string; description: string | null }

export type AskQuestion = {
    header: string | null
    question: string
    options: ChoiceOption[]
    multiSelect: boolean
}

export type InputQuestion = {
    id: string
    question: string
    options: ChoiceOption[]
}

/** Prefix the agent side uses to tell a free-text note apart from a chosen label. */
export const USER_NOTE_PREFIX = 'user_note: '

export function isAskUserQuestionTool(tool: string): boolean {
    return tool === 'AskUserQuestion' || tool === 'ask_user_question'
}

export function isRequestUserInputTool(tool: string): boolean {
    return tool === 'request_user_input'
}

export function isQuestionTool(tool: string): boolean {
    return isAskUserQuestionTool(tool) || isRequestUserInputTool(tool)
}

function parseOptions(raw: unknown): ChoiceOption[] {
    if (!Array.isArray(raw)) return []
    const out: ChoiceOption[] = []
    for (const entry of raw) {
        if (!isObject(entry)) continue
        const label = typeof entry.label === 'string' ? entry.label.trim() : ''
        // An option with no label cannot be selected or sent back; drop it.
        if (!label) continue
        out.push({
            label,
            description: typeof entry.description === 'string' && entry.description ? entry.description : null
        })
    }
    return out
}

function questionList(args: unknown): unknown[] {
    if (!isObject(args)) return []
    return Array.isArray(args.questions) ? args.questions : []
}

export function parseAskQuestions(args: unknown): AskQuestion[] {
    const out: AskQuestion[] = []
    for (const raw of questionList(args)) {
        if (!isObject(raw)) continue
        const question = typeof raw.question === 'string' ? raw.question.trim() : ''
        const options = parseOptions(raw.options)
        // Nothing to show and nothing to pick — not a question.
        if (!question && options.length === 0) continue
        out.push({
            header: typeof raw.header === 'string' && raw.header ? raw.header : null,
            question,
            options,
            multiSelect: raw.multiSelect === true
        })
    }
    return out
}

export function parseInputQuestions(args: unknown): InputQuestion[] {
    const out: InputQuestion[] = []
    for (const raw of questionList(args)) {
        if (!isObject(raw)) continue
        // `id` is the answer key, so a question without one can never be answered.
        const id = typeof raw.id === 'string' ? raw.id.trim() : ''
        if (!id) continue
        out.push({
            id,
            question: typeof raw.question === 'string' ? raw.question.trim() : '',
            options: parseOptions(raw.options)
        })
    }
    return out
}

/** Flat, index-keyed. Empty questions are omitted so the caller can reject the submission. */
export function buildAskAnswers(
    questions: AskQuestion[],
    read: (index: number) => { selected: string[]; other: string }
): Record<string, string[]> {
    const answers: Record<string, string[]> = {}
    questions.forEach((question, index) => {
        const { selected, other } = read(index)
        const valid = selected.filter((value) => question.options.some((o) => o.label === value))
        // Free text rides along as one more answer, exactly as the full UI does.
        const all = other.trim() ? [...valid, other.trim()] : valid
        if (all.length > 0) answers[String(index)] = all
    })
    return answers
}

/** Nested, id-keyed, chosen label first and the note last. */
export function buildInputAnswers(
    questions: InputQuestion[],
    read: (id: string) => { selected: string; note: string }
): Record<string, { answers: string[] }> {
    const answers: Record<string, { answers: string[] }> = {}
    for (const question of questions) {
        const { selected, note } = read(question.id)
        const values: string[] = []
        if (selected && question.options.some((o) => o.label === selected)) values.push(selected)
        if (note.trim()) values.push(`${USER_NOTE_PREFIX}${note.trim()}`)
        if (values.length > 0) answers[question.id] = { answers: values }
    }
    return answers
}
