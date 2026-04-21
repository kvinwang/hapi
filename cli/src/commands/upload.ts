import { basename, resolve } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import chalk from 'chalk'
import { ApiClient } from '@/api/api'
import { initializeToken } from '@/ui/tokenInit'
import type { CommandDefinition } from './types'

type OutputFormat = 'json' | 'text'

type UploadArgs = {
    sessionId: string
    filePath: string
    filename: string
    format: OutputFormat
}

const MAX_UPLOAD_FILE_BYTES = 35 * 1024 * 1024

function readOptionValue(args: string[], arg: string, index: number): { value: string; nextIndex: number } {
    const eqIndex = arg.indexOf('=')
    if (eqIndex >= 0) {
        return { value: arg.slice(eqIndex + 1), nextIndex: index }
    }
    const next = args[index + 1]
    if (!next) {
        throw new Error(`Missing value for ${arg}`)
    }
    return { value: next, nextIndex: index + 1 }
}

function parseUploadArgs(args: string[]): UploadArgs {
    let sessionId = process.env.HAPI_SESSION_ID?.trim() || ''
    let filename: string | undefined
    let format: OutputFormat = 'text'
    let filePath: string | undefined

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i]

        if (arg === '--session' || arg === '-s' || arg.startsWith('--session=')) {
            const { value, nextIndex } = readOptionValue(args, arg, i)
            sessionId = value.trim()
            i = nextIndex
            continue
        }
        if (arg === '--name' || arg.startsWith('--name=')) {
            const { value, nextIndex } = readOptionValue(args, arg, i)
            filename = value.trim()
            i = nextIndex
            continue
        }
        if (arg === '--format' || arg.startsWith('--format=')) {
            const { value, nextIndex } = readOptionValue(args, arg, i)
            if (value !== 'json' && value !== 'text') {
                throw new Error('--format must be json or text')
            }
            format = value
            i = nextIndex
            continue
        }
        if (arg.startsWith('-')) {
            throw new Error(`Unknown option: ${arg}`)
        }
        if (filePath) {
            throw new Error('Only one file path is allowed')
        }
        filePath = arg
    }

    if (!sessionId) {
        throw new Error('Missing session ID. Set HAPI_SESSION_ID or pass --session <id>')
    }
    if (!filePath) {
        throw new Error('Missing file path')
    }

    const resolvedPath = resolve(filePath)
    const resolvedFilename = filename?.trim() || basename(resolvedPath)
    if (!resolvedFilename) {
        throw new Error('Missing filename')
    }

    return {
        sessionId,
        filePath: resolvedPath,
        filename: resolvedFilename,
        format
    }
}

function printUsage(): void {
    console.log('Usage:')
    console.log('  hapi upload [--session <id>] [--name <filename>] <path>')
    console.log('')
    console.log('Options:')
    console.log('  --session <id>       Session ID (defaults to HAPI_SESSION_ID)')
    console.log('  --name <filename>    Override uploaded filename')
    console.log('  --format <fmt>       json | text (default: text)')
}

async function runUpload(args: string[]): Promise<void> {
    const parsed = parseUploadArgs(args)
    const fileInfo = await stat(parsed.filePath)
    if (!fileInfo.isFile()) {
        throw new Error('Path must point to a file')
    }
    if (fileInfo.size > MAX_UPLOAD_FILE_BYTES) {
        throw new Error('File too large (max 35MB)')
    }

    await initializeToken()
    const api = await ApiClient.create()

    const buffer = await readFile(parsed.filePath)
    const result = await api.uploadHostedFile({
        sessionId: parsed.sessionId,
        filename: parsed.filename,
        content: buffer.toString('base64'),
        mimeType: Bun.file(parsed.filePath).type || 'application/octet-stream'
    })

    if (parsed.format === 'json') {
        console.log(JSON.stringify({
            id: result.id,
            url: result.url,
            filename: parsed.filename,
            sessionId: parsed.sessionId
        }, null, 2))
        return
    }

    console.log(result.url)
}

export const uploadCommand: CommandDefinition = {
    name: 'upload',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        try {
            await runUpload(commandArgs)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            printUsage()
            process.exit(1)
        }
    }
}
