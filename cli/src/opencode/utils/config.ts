export function buildOpencodeEnv(args: { sessionId?: string } = {}): NodeJS.ProcessEnv {
    return {
        ...process.env,
        ...(args.sessionId ? { HAPI_SESSION_ID: args.sessionId } : {})
    };
}
