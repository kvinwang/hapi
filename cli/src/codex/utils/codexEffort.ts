/** Preserve agent-defined effort IDs, including xhigh/max and newly introduced levels. */
export function mapCodexEffort(value: string): string | undefined {
    const effort = value.trim()
    return !effort || effort === 'default' ? undefined : effort
}
