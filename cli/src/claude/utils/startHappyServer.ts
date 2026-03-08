/**
 * HAPI MCP server
 * Provides HAPI CLI specific tools including chat session title management
 * and file uploading for the file hosting feature.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AddressInfo } from "node:net";
import { z } from "zod";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import { configuration } from "@/configuration";
import { randomUUID } from "node:crypto";

const MAX_FILE_BYTES = 50 * 1024 * 1024

export async function startHappyServer(client: ApiSessionClient) {
    // Handler that sends title updates via the client
    const handler = async (title: string) => {
        logger.debug('[hapiMCP] Changing title to:', title);
        try {
            // Send title as a summary message, similar to title generator
            client.sendClaudeSessionMessage({
                type: 'summary',
                summary: title,
                leafUuid: randomUUID()
            });

            return { success: true };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    };

    //
    // Create the MCP server
    //

    const mcp = new McpServer({
        name: "HAPI MCP",
        version: "1.0.0",
    });

    // Avoid TS instantiation depth issues by widening the schema type.
    const changeTitleInputSchema: z.ZodTypeAny = z.object({
        title: z.string().describe('The new title for the chat session'),
    });

    mcp.registerTool<any, any>('change_title', {
        description: 'Change the title of the current chat session',
        title: 'Change Chat Title',
        inputSchema: changeTitleInputSchema,
    }, async (args: { title: string }) => {
        const response = await handler(args.title);
        logger.debug('[hapiMCP] Response:', response);

        if (response.success) {
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: `Successfully changed chat title to: "${args.title}"`,
                    },
                ],
                isError: false,
            };
        } else {
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: `Failed to change chat title: ${response.error || 'Unknown error'}`,
                    },
                ],
                isError: true,
            };
        }
    });

    // upload_file tool — reads a local file and uploads to Hub
    const uploadFileInputSchema: z.ZodTypeAny = z.object({
        file_path: z.string().describe('Absolute path to the file on the local filesystem'),
    });

    mcp.registerTool<any, any>('upload_file', {
        description: 'Upload a local file to the HAPI file hosting service. Returns a URL that can be used in markdown. For images, use ![description](url) to render inline. For other files, use [filename](url) as a download link.',
        title: 'Upload File',
        inputSchema: uploadFileInputSchema,
    }, async (args: { file_path: string }) => {
        try {
            const filePath = args.file_path;
            logger.debug('[hapiMCP] Uploading file:', filePath);

            // Get extension
            const ext = extname(filePath).toLowerCase().replace(/^\./, '');
            if (!ext) {
                return {
                    content: [{ type: 'text' as const, text: 'File has no extension. Cannot determine file type.' }],
                    isError: true,
                };
            }

            // Check file size
            const fileStat = await stat(filePath);
            if (fileStat.size > MAX_FILE_BYTES) {
                return {
                    content: [{ type: 'text' as const, text: `File too large: ${(fileStat.size / 1024 / 1024).toFixed(1)}MB (max 50MB)` }],
                    isError: true,
                };
            }

            // Read and encode
            const buffer = await readFile(filePath);
            const base64 = buffer.toString('base64');

            // Upload to Hub
            const response = await fetch(`${configuration.apiUrl}/cli/files`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${configuration.cliApiToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    content: base64,
                    ext,
                    sessionId: client.sessionId,
                }),
            });

            if (!response.ok) {
                const error = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
                return {
                    content: [{ type: 'text' as const, text: `Failed to upload file: ${error.error || response.statusText}` }],
                    isError: true,
                };
            }

            const result = await response.json() as { id: string; url: string };
            logger.debug('[hapiMCP] File uploaded:', result.url);

            return {
                content: [{ type: 'text' as const, text: `File uploaded successfully. URL:\n${result.url}` }],
                isError: false,
            };
        } catch (error) {
            logger.debug('[hapiMCP] File upload error:', error);
            return {
                content: [{ type: 'text' as const, text: `Failed to upload file: ${error instanceof Error ? error.message : String(error)}` }],
                isError: true,
            };
        }
    });

    const transport = new StreamableHTTPServerTransport({
        // NOTE: Returning session id here will result in claude
        // sdk spawn to fail with `Invalid Request: Server already initialized`
        sessionIdGenerator: undefined
    });
    await mcp.connect(transport);

    //
    // Create the HTTP server
    //

    const server = createServer(async (req, res) => {
        try {
            await transport.handleRequest(req, res);
        } catch (error) {
            logger.debug("Error handling request:", error);
            if (!res.headersSent) {
                res.writeHead(500).end();
            }
        }
    });

    const baseUrl = await new Promise<URL>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as AddressInfo;
            resolve(new URL(`http://127.0.0.1:${addr.port}`));
        });
    });

    return {
        url: baseUrl.toString(),
        toolNames: ['change_title', 'upload_file'],
        stop: () => {
            logger.debug('[hapiMCP] Stopping server');
            mcp.close();
            server.close();
        }
    }
}
