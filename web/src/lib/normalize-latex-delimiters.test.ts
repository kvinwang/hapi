import { describe, expect, it } from 'vitest'
import { normalizeLatexDelimiters } from './normalize-latex-delimiters'

describe('normalizeLatexDelimiters', () => {
    it('converts display and inline LaTeX delimiters', () => {
        expect(normalizeLatexDelimiters('\\[x^2\\]\nand \\(y\\)')).toBe('$$x^2$$\nand $y$')
    })

    it('preserves delimiters in inline code', () => {
        expect(normalizeLatexDelimiters('Use `\\(x\\)` or ``\\[x\\]``.')).toBe('Use `\\(x\\)` or ``\\[x\\]``.')
    })

    it('preserves delimiters in fenced code blocks', () => {
        const markdown = 'Before \\(x\\)\n```latex\n\\[y\\]\n```\nAfter \\[z\\]'
        const expected = 'Before $x$\n```latex\n\\[y\\]\n```\nAfter $$z$$'

        expect(normalizeLatexDelimiters(markdown)).toBe(expected)
    })

    it('preserves escaped backslashes', () => {
        expect(normalizeLatexDelimiters(String.raw`Literal \\[x\\]`)).toBe(String.raw`Literal \\[x\\]`)
    })
})
