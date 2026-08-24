import {
	createMcpHandler,
	INVALID_PARAMS,
	ProtocolError,
	Server,
} from "@modelcontextprotocol/server";
import type { Hono } from "hono";

import { assembleOpenAPIDocument } from "@/lib/openapi";

import { createRouter, type HonoVariables } from "@/utils";

import packageJson from "../../../package.json";
import { executeTool } from "./_service.execute";
import type { OpenApiDocument } from "./_types";
import {
	isToolPermitted,
	resolvePermittedCollections,
} from "./_util.permissions";
import { buildToolsFromOpenApi } from "./_util.tools";

/**
 * Fully stateless: every request gets a fresh Server via a factory closure
 * that captures the Hono context. Tools are built from a freshly assembled
 * OpenAPI document and filtered by the request's collection permissions.
 *
 * Uses createMcpHandler from @modelcontextprotocol/server v2, which handles
 * both modern (2026-07-28) and legacy (2025-era) protocol traffic. The
 * factory closure pattern ensures Hono's AsyncLocalStorage context
 * (contextStorage middleware) is active during tool execution.
 */
export const createMcpRouter = (app: Hono<HonoVariables>) => {
	const router = createRouter().all("/", async (c) => {
		// Build tools eagerly inside the Hono async context so that
		// assembleOpenAPIDocument and permission checks run with full
		// access to Hono's AsyncLocalStorage (contextStorage middleware).
		const result = await assembleOpenAPIDocument(c.var.deps);
		const permittedCollections = resolvePermittedCollections(c);
		const tools = result.isOk()
			? buildToolsFromOpenApi({
					spec: result.value as OpenApiDocument,
				}).filter((tool) => isToolPermitted({ tool, permittedCollections }))
			: [];

		const createServer = () => {
			const server = new Server(
				{ name: "pouch", version: packageJson.version },
				{ capabilities: { tools: {} } },
			);

			server.setRequestHandler("tools/list", () => ({
				tools: tools.map(
					({
						name,
						title,
						description,
						inputSchema,
						outputSchema,
						annotations,
					}) => ({
						name,
						...(title ? { title } : {}),
						description,
						inputSchema: inputSchema as {
							type: "object";
							[key: string]: unknown;
						},
						...(outputSchema ? { outputSchema } : {}),
						annotations,
					}),
				),
			}));

			server.setRequestHandler("tools/call", async (request) => {
				const tool = tools.find(
					(candidate) => candidate.name === request.params.name,
				);
				if (!tool) {
					throw new ProtocolError(
						INVALID_PARAMS,
						`Tool ${request.params.name} not found`,
					);
				}
				return executeTool({
					tool,
					args: (request.params.arguments ?? {}) as Record<string, unknown>,
					app,
				});
			});

			return server;
		};

		const handler = createMcpHandler(createServer);
		return handler.fetch(c.req.raw);
	});

	return router;
};
