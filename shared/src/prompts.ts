function normalizePromptSection(value: string | null | undefined): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

export function joinPromptSections(...sections: Array<string | null | undefined>): string | undefined {
    const normalized = sections
        .map((section) => normalizePromptSection(section))
        .filter((section): section is string => Boolean(section));

    if (normalized.length === 0) {
        return undefined;
    }

    return normalized.join('\n\n');
}

export const hapiSystemPrompt = joinPromptSections(
    'ALWAYS when you start a new chat - run `hapi session set-title "<title>"` to set a chat title. This command uses the current HAPI session automatically. When you think the chat title is not relevant anymore - run the command again. When the chat name is too generic and you have a chance to make it more specific - run the command again. This title is needed to easily find the chat in the future. Help human.',
    'When you need to share files with the user - run `hapi upload --name "<filename>" "<path>"`. This command prints a URL. Use the returned URL in markdown. For images use ![description](url) to render inline. For other files use [filename](url) as a download link.',
    'Your HAPI session ID is available in the environment variable HAPI_SESSION_ID. Read it with echo $HAPI_SESSION_ID when needed.'
) ?? '';

export function buildStoredSystemPrompt(args: {
    globalPrompt?: string | null;
    sessionPrompt?: string | null;
    includeGlobal?: boolean;
}): string | undefined {
    if (args.includeGlobal === false) {
        return joinPromptSections(args.sessionPrompt);
    }

    return joinPromptSections(args.globalPrompt, args.sessionPrompt);
}

export function buildMessageAppendSystemPrompt(args: {
    globalPrompt?: string | null;
    sessionPrompt?: string | null;
    includeGlobal?: boolean;
}): string {
    return joinPromptSections(
        buildStoredSystemPrompt(args),
        hapiSystemPrompt
    ) ?? hapiSystemPrompt;
}
