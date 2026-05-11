/**
 * Returns true when the tool name identifies a subagent invocation.
 *
 * The Claude Code SDK has used two names for the same concept:
 *   - 'Task'  — earlier SDK releases
 *   - 'Agent' — later SDK releases
 *
 * Both share the same input shape: { prompt: string, subagent_type: string }.
 */
export function isSubagentToolName(name: string): boolean {
    return name === 'Task' || name === 'Agent' || name.startsWith('Agent:') || name.startsWith('Task:')
}
