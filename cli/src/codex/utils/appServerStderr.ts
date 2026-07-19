import { stripVTControlCharacters } from 'node:util';

export function extractAppServerTurnError(stderr: string): string | null {
    const text = stripVTControlCharacters(stderr);
    const line = text.split('\n').find((candidate) =>
        candidate.includes('ERROR') && candidate.includes('codex_core::session::turn')
    );
    if (!line) return null;

    const moduleEnd = line.indexOf('codex_core::session::turn');
    const message = line.slice(moduleEnd + 'codex_core::session::turn'.length)
        .replace(/^\s*:\s*/, '')
        .trim();
    return message || 'Codex turn failed';
}
