import { describe, expect, it } from 'bun:test'
import {
    buildAskAnswers,
    buildInputAnswers,
    isAskUserQuestionTool,
    isQuestionTool,
    isRequestUserInputTool,
    parseAskQuestions,
    parseInputQuestions
} from './questions'

/**
 * The two question tools answer in different shapes, and getting either wrong fails
 * quietly: the agent receives an empty answer set and the turn stalls rather than
 * erroring. These tests exist to pin the exact wire formats.
 */

describe('tool detection', () => {
    it('recognises both spellings of AskUserQuestion', () => {
        expect(isAskUserQuestionTool('AskUserQuestion')).toBe(true)
        expect(isAskUserQuestionTool('ask_user_question')).toBe(true)
        expect(isAskUserQuestionTool('Bash')).toBe(false)
    })

    it('recognises request_user_input', () => {
        expect(isRequestUserInputTool('request_user_input')).toBe(true)
        expect(isQuestionTool('request_user_input')).toBe(true)
        expect(isQuestionTool('Edit')).toBe(false)
    })
})

describe('parseAskQuestions', () => {
    it('reads header, options and multiSelect', () => {
        const parsed = parseAskQuestions({
            questions: [
                { header: 'Storage', question: 'Which backend?', options: [{ label: 'Redis', description: 'Fast' }] },
                { question: 'Extras?', multiSelect: true, options: [{ label: 'Metrics' }] }
            ]
        })
        expect(parsed).toHaveLength(2)
        expect(parsed[0]).toEqual({
            header: 'Storage',
            question: 'Which backend?',
            options: [{ label: 'Redis', description: 'Fast' }],
            multiSelect: false
        })
        expect(parsed[1].multiSelect).toBe(true)
        expect(parsed[1].header).toBeNull()
        expect(parsed[1].options[0].description).toBeNull()
    })

    it('drops options that could never be submitted', () => {
        const parsed = parseAskQuestions({
            questions: [{ question: 'q', options: [{ label: '' }, { description: 'no label' }, { label: 'ok' }] }]
        })
        expect(parsed[0].options).toEqual([{ label: 'ok', description: null }])
    })

    it('ignores malformed input rather than throwing', () => {
        expect(parseAskQuestions(null)).toEqual([])
        expect(parseAskQuestions({})).toEqual([])
        expect(parseAskQuestions({ questions: 'nope' })).toEqual([])
        expect(parseAskQuestions({ questions: [{}, 42, null] })).toEqual([])
    })
})

describe('parseInputQuestions', () => {
    it('keeps questions with an id, including option-less ones', () => {
        const parsed = parseInputQuestions({
            questions: [
                { id: 'backend', question: 'Which?', options: [{ label: 'Redis' }] },
                { id: 'notes', question: 'Anything else?', options: [] }
            ]
        })
        expect(parsed).toHaveLength(2)
        expect(parsed[1].options).toEqual([])
    })

    it('drops a question with no id, since the id is the answer key', () => {
        const parsed = parseInputQuestions({ questions: [{ question: 'orphan', options: [] }, { id: 'a', question: 'x' }] })
        expect(parsed.map((q) => q.id)).toEqual(['a'])
    })
})

describe('buildAskAnswers', () => {
    const questions = parseAskQuestions({
        questions: [
            { question: 'Which backend?', options: [{ label: 'Redis' }, { label: 'SQLite' }] },
            { question: 'Extras?', multiSelect: true, options: [{ label: 'Metrics' }, { label: 'Tracing' }] }
        ]
    })

    it('keys answers by the question index as a string', () => {
        // Load-bearing: the agent side maps this index back to the question text. Keying
        // by header or id yields an empty answer set and stalls the turn.
        const answers = buildAskAnswers(questions, (i) => ({
            selected: i === 0 ? ['Redis'] : ['Metrics', 'Tracing'],
            other: ''
        }))
        expect(answers).toEqual({ '0': ['Redis'], '1': ['Metrics', 'Tracing'] })
    })

    it('appends free text as an extra answer', () => {
        const answers = buildAskAnswers(questions, (i) => ({
            selected: i === 0 ? [] : [],
            other: i === 0 ? 'Postgres' : ''
        }))
        expect(answers).toEqual({ '0': ['Postgres'] })
    })

    it('keeps a selection alongside free text', () => {
        const answers = buildAskAnswers(questions, () => ({ selected: ['Redis'], other: 'and a note' }))
        expect(answers['0']).toEqual(['Redis', 'and a note'])
    })

    it('discards values that are not real options', () => {
        // Field names are attacker-controllable; only labels from the live request count.
        const answers = buildAskAnswers(questions, () => ({ selected: ['Redis', 'injected'], other: '' }))
        expect(answers['0']).toEqual(['Redis'])
    })

    it('omits unanswered questions so the caller can reject an empty submission', () => {
        expect(buildAskAnswers(questions, () => ({ selected: [], other: '   ' }))).toEqual({})
    })
})

describe('buildInputAnswers', () => {
    const questions = parseInputQuestions({
        questions: [
            { id: 'backend', question: 'Which?', options: [{ label: 'Redis' }, { label: 'SQLite' }] },
            { id: 'notes', question: 'Anything else?', options: [] }
        ]
    })

    it('nests answers under the question id, label first and note last', () => {
        const answers = buildInputAnswers(questions, (id) => id === 'backend'
            ? { selected: 'Redis', note: 'keep TLS on' }
            : { selected: '', note: 'ship Friday' })
        expect(answers).toEqual({
            backend: { answers: ['Redis', 'user_note: keep TLS on'] },
            notes: { answers: ['user_note: ship Friday'] }
        })
    })

    it('answers an option-less question with the note alone', () => {
        const answers = buildInputAnswers(questions, (id) => ({ selected: '', note: id === 'notes' ? 'hi' : '' }))
        expect(answers).toEqual({ notes: { answers: ['user_note: hi'] } })
    })

    it('discards a selection that is not one of the offered options', () => {
        const answers = buildInputAnswers(questions, (id) => ({
            selected: id === 'backend' ? 'injected' : '',
            note: ''
        }))
        expect(answers).toEqual({})
    })

    it('omits everything when nothing was answered', () => {
        expect(buildInputAnswers(questions, () => ({ selected: '', note: '' }))).toEqual({})
    })
})
