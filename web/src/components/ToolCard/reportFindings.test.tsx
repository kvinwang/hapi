import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ToolCallBlock } from '@hapi/protocol/chat'
import { parseReportFindings } from '@/components/ToolCard/reportFindings'
import { getToolPresentation } from '@/components/ToolCard/knownTools'
import { getToolFullViewComponent, getToolViewComponent } from '@/components/ToolCard/views/_all'
import { isEligibleForToolGrouping } from '@/chat/toolGroups'

// The real renderer needs an assistant-ui thread context that no tool card owns in isolation.
vi.mock('@/components/MarkdownRenderer', () => ({
    MarkdownRenderer: (props: { content: string }) => <div>{props.content}</div>
}))

const INPUT = {
    level: 'high',
    findings: [
        {
            file: '/repo/gateway/src/kv/mod.rs',
            line: 1144,
            category: 'correctness',
            summary: '`previous?` returns before the logging loop.',
            failure_scenario: 'Disk-full fails every delete; the override errors never reach the log.',
            short_summary: 'inst/ failure skips override delete logging',
            verdict: 'CONFIRMED'
        },
        {
            file: 'gateway/src/main_service.rs',
            line: 185,
            category: 'docs-accuracy',
            summary: 'The doc calls persistent overrides telemetry.',
            failure_scenario: 'A recycled instance id inherits a stale gate.',
            verdict: 'PLAUSIBLE',
            outcome: 'skipped'
        }
    ]
}

function makeBlock(input: unknown, result?: unknown): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: 'tool-1',
        localId: null,
        createdAt: 0,
        tool: {
            id: 'tool-1',
            name: 'ReportFindings',
            state: 'completed',
            input,
            createdAt: 0,
            startedAt: 0,
            completedAt: 0,
            description: null,
            result
        },
        children: []
    }
}

describe('parseReportFindings', () => {
    it('normalizes findings from the tool input', () => {
        const parsed = parseReportFindings(INPUT)

        expect(parsed.level).toBe('high')
        expect(parsed.findings).toHaveLength(2)
        expect(parsed.findings[0]).toEqual({
            file: '/repo/gateway/src/kv/mod.rs',
            line: 1144,
            category: 'correctness',
            summary: '`previous?` returns before the logging loop.',
            shortSummary: 'inst/ failure skips override delete logging',
            failureScenario: 'Disk-full fails every delete; the override errors never reach the log.',
            verdict: 'CONFIRMED',
            outcome: null
        })
        expect(parsed.findings[1].outcome).toBe('skipped')
        expect(parsed.findings[1].verdict).toBe('PLAUSIBLE')
    })

    it('drops empty placeholders streamed before the fields land', () => {
        expect(parseReportFindings({ findings: [{}, { file: 'a.ts' }] }).findings).toHaveLength(1)
    })

    it('falls back to the result payload and tolerates junk', () => {
        expect(parseReportFindings(null, INPUT).findings).toHaveLength(2)
        expect(parseReportFindings('nope').findings).toEqual([])
        expect(parseReportFindings({ findings: 'nope' }).findings).toEqual([])
    })
})

describe('ReportFindings presentation', () => {
    function presentationFor(input: unknown) {
        return getToolPresentation({
            toolName: 'ReportFindings',
            input,
            result: undefined,
            childrenCount: 0,
            description: null,
            metadata: null
        })
    }

    it('titles the card with the finding count and leads with the first headline', () => {
        const presentation = presentationFor(INPUT)
        expect(presentation.title).toBe('2 findings')
        expect(presentation.subtitle).toBe('inst/ failure skips override delete logging (+1 more)')
        expect(presentation.minimal).toBe(false)
    })

    it('stays minimal when nothing was reported', () => {
        const presentation = presentationFor({ findings: [] })
        expect(presentation.title).toBe('No findings')
        expect(presentation.subtitle).toBeNull()
        expect(presentation.minimal).toBe(true)
    })

    it('never folds into a tool group', () => {
        expect(isEligibleForToolGrouping(makeBlock(INPUT))).toBe(false)
    })
})

describe('ReportFindingsView', () => {
    it('renders one row per finding with location and verdict', () => {
        const View = getToolViewComponent('ReportFindings')
        if (!View) throw new Error('ReportFindings view is not registered')

        render(<View block={makeBlock(INPUT)} metadata={{ path: '/repo' } as never} />)

        expect(screen.getByText('high effort')).toBeDefined()
        // Session root is stripped from the absolute path.
        expect(screen.getByText('gateway/src/kv/mod.rs:1144')).toBeDefined()
        expect(screen.getByText('gateway/src/main_service.rs:185')).toBeDefined()
        expect(screen.getByText('CONFIRMED')).toBeDefined()
        expect(screen.getByText('skipped')).toBeDefined()
        expect(screen.getByText('inst/ failure skips override delete logging')).toBeDefined()
        // No short_summary on the second finding: fall back to the summary.
        expect(screen.getByText('The doc calls persistent overrides telemetry.')).toBeDefined()
    })

    it('renders the failure scenario in the detail view', () => {
        const FullView = getToolFullViewComponent('ReportFindings')
        if (!FullView) throw new Error('ReportFindings full view is not registered')

        render(<FullView block={makeBlock(INPUT)} metadata={null} />)

        expect(screen.getAllByText('Failure scenario')).toHaveLength(2)
        expect(screen.getByText('A recycled instance id inherits a stale gate.')).toBeDefined()
    })

    it('reports an empty finding list instead of rendering nothing', () => {
        const View = getToolViewComponent('ReportFindings')
        if (!View) throw new Error('ReportFindings view is not registered')

        render(<View block={makeBlock({ findings: [] })} metadata={null} />)
        expect(screen.getByText('No findings reported.')).toBeDefined()
    })
})
