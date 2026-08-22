import { isObject } from '@hapi/protocol'

/**
 * Claude Code's `ReportFindings` tool (code review skills) hands the UI a typed
 * finding list instead of prose. Parsing lives here so the card header, the
 * inline view and the detail dialog all read the same normalized shape.
 */

export type FindingVerdict = 'CONFIRMED' | 'PLAUSIBLE'
export type FindingOutcome = 'fixed' | 'skipped' | 'no_change_needed'

export type ReviewFinding = {
    file: string | null
    line: number | null
    category: string | null
    summary: string | null
    shortSummary: string | null
    failureScenario: string | null
    verdict: FindingVerdict | null
    outcome: FindingOutcome | null
}

export type ReportFindingsPayload = {
    findings: ReviewFinding[]
    level: string | null
}

const REPORT_FINDINGS_TOOL_NAMES = new Set([
    'ReportFindings',
    'report_findings'
])

export function isReportFindingsToolName(toolName: string): boolean {
    return REPORT_FINDINGS_TOOL_NAMES.has(toolName)
}

function readString(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
}

function readLine(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
    if (typeof value === 'string') {
        const parsed = Number.parseInt(value, 10)
        if (Number.isFinite(parsed)) return parsed
    }
    return null
}

function readVerdict(value: unknown): FindingVerdict | null {
    if (typeof value !== 'string') return null
    const upper = value.trim().toUpperCase()
    return upper === 'CONFIRMED' || upper === 'PLAUSIBLE' ? upper : null
}

function readOutcome(value: unknown): FindingOutcome | null {
    if (typeof value !== 'string') return null
    const lower = value.trim().toLowerCase()
    if (lower === 'fixed' || lower === 'skipped' || lower === 'no_change_needed') return lower
    return null
}

function parseFinding(entry: unknown): ReviewFinding | null {
    if (!isObject(entry)) return null

    const finding: ReviewFinding = {
        file: readString(entry.file),
        line: readLine(entry.line),
        category: readString(entry.category),
        summary: readString(entry.summary),
        shortSummary: readString(entry.short_summary) ?? readString(entry.shortSummary),
        failureScenario: readString(entry.failure_scenario) ?? readString(entry.failureScenario),
        verdict: readVerdict(entry.verdict),
        outcome: readOutcome(entry.outcome)
    }

    // Streaming input can deliver `{}` placeholders before the fields land.
    const hasContent = finding.file !== null
        || finding.summary !== null
        || finding.shortSummary !== null
        || finding.failureScenario !== null
    return hasContent ? finding : null
}

function parseCandidate(candidate: unknown): ReportFindingsPayload | null {
    if (!isObject(candidate) || !Array.isArray(candidate.findings)) return null
    const findings: ReviewFinding[] = []
    for (const entry of candidate.findings) {
        const finding = parseFinding(entry)
        if (finding) findings.push(finding)
    }
    return { findings, level: readString(candidate.level) }
}

/** Input is authoritative; the result only carries a "N findings reported." string. */
export function parseReportFindings(input: unknown, result?: unknown): ReportFindingsPayload {
    return parseCandidate(input) ?? parseCandidate(result) ?? { findings: [], level: null }
}

/** One-line label for a finding: `path/to/file.rs:120`. */
export function formatFindingLocation(finding: ReviewFinding, displayFile: string | null): string | null {
    const file = displayFile ?? finding.file
    if (!file) return null
    return finding.line === null ? file : `${file}:${finding.line}`
}

export function findingHeadline(finding: ReviewFinding): string {
    return finding.shortSummary ?? finding.summary ?? finding.failureScenario ?? '(empty finding)'
}
