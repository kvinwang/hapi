import { build, type BuildConfig } from 'bun'

const isWatch = process.argv.includes('--watch')

const config: BuildConfig = {
    entrypoints: ['./src/background.ts'],
    outdir: './dist',
    target: 'browser',
    format: 'esm',
    minify: !isWatch,
    sourcemap: isWatch ? 'external' : 'none',
}

if (isWatch) {
    console.log('Watching for changes...')
    // Bun doesn't have native watch build, so just build once
    // For dev, run `bun run build` after changes
}

const result = await build(config)

if (!result.success) {
    console.error('Build failed:')
    for (const log of result.logs) {
        console.error(log)
    }
    process.exit(1)
}

console.log('Build complete:', result.outputs.map(o => o.path))
