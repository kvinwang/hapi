import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const source = `export default function (pi) {
    pi.on("tool_call", async (event, ctx) => {
        const confirmed = await ctx.ui.confirm(
            "Allow " + event.toolName + "?",
            JSON.stringify({ toolName: event.toolName, toolCallId: event.toolCallId, input: event.input })
        );
        if (!confirmed) return { block: true, reason: "Denied by user" };
    });
}`

export async function createPiExtension(): Promise<{ path: string; dispose: () => Promise<void> }> {
    const { rm } = await import('node:fs/promises')
    const dir = await mkdtemp(join(tmpdir(), 'hapi-pi-extension-'))
    const path = join(dir, 'permission-gate.js')
    await writeFile(path, source, { mode: 0o600 })
    return { path, dispose: () => rm(dir, { recursive: true, force: true }) }
}
