import {
	CimdFetchError,
	getOAuthApi,
	type OAuthHelpers,
	type OAuthProviderOptions,
	type ResolveExternalTokenResult,
} from "@cloudflare/workers-oauth-provider";
import { verify } from "hono/jwt";
import { ResultAsync } from "neverthrow";

import { SCOPES } from "@/middleware/auth";

export const OAUTH_AUTHORIZE_ENDPOINT = "/authorize";
export const OAUTH_TOKEN_ENDPOINT = "/token";
export const OAUTH_REGISTRATION_ENDPOINT = "/register";

/**
 * Provider options shared between the OAuthProvider wrapper (src/index.ts)
 * and anything that needs OAuthHelpers. Endpoints and scopes must stay in
 * sync — helpers resolve clients and grants from the same OAUTH_KV registry.
 */
export const baseOAuthProviderOptions = {
	authorizeEndpoint: OAUTH_AUTHORIZE_ENDPOINT,
	tokenEndpoint: OAUTH_TOKEN_ENDPOINT,
	scopesSupported: [...SCOPES],
	// RFC 9728 protected-resource metadata. scopes_supported is what MCP
	// clients discover and request — without it clients ask for zero scopes
	// and the consent page shows "No permissions requested".
	resourceMetadata: {
		scopes_supported: [...SCOPES],
	},
	// RFC 7591 dynamic client registration — MCP clients self-register.
	// Registered clients expire after the library default of 90 days and
	// re-register on demand.
	clientRegistrationEndpoint: OAUTH_REGISTRATION_ENDPOINT,
	// Enable Client ID Metadata Documents (CIMD) so MCP clients
	// (ChatGPT, Claude, Cursor, VS Code) can send client_id as a
	// metadata-document URL instead of registering via DCR.
	clientIdMetadataDocumentEnabled: true,
} satisfies Partial<OAuthProviderOptions<Env>>;

/**
 * Build OAuthHelpers for the given env. OAuthProviderImpl validates that an
 * API handler and default handler exist, but neither is ever invoked through
 * the helpers API (clients/grants KV operations only).
 */
export const getOAuthHelpers = (env: Env): OAuthHelpers =>
	getOAuthApi(
		{
			...baseOAuthProviderOptions,
			apiRoute: "/mcp",
			apiHandler: {
				fetch: () => new Response("Not found", { status: 404 }),
			},
			defaultHandler: {
				fetch: () => new Response("Not found", { status: 404 }),
			},
		},
		env,
	);

/**
 * Merge base OAuth options with env-driven resource metadata. When
 * MCP_RESOURCE_URL is set, pins the protected resource and advertises
 * the authorization server origin for RFC 9728 discovery.
 */
export const buildOAuthProviderOptions = (
	env: Env,
): Partial<OAuthProviderOptions<Env>> => ({
	...baseOAuthProviderOptions,
	resourceMetadata: {
		...baseOAuthProviderOptions.resourceMetadata,
		...(env.MCP_RESOURCE_URL
			? {
					resource: env.MCP_RESOURCE_URL,
					authorization_servers: [new URL(env.MCP_RESOURCE_URL).origin],
				}
			: {}),
	},
});

/**
 * OAuthProvider callback for tokens missing from its own KV registry. A
 * valid pouch JWT (minted via /auth/keys) is accepted and passed through as
 * props.accessToken, so header-capable MCP clients can keep using plain
 * bearer tokens while OAuth-only clients use the consent flow.
 */
export const resolveExternalPouchToken = async ({
	token,
	env,
}: {
	token: string;
	request: Request;
	env: Env;
}): Promise<ResolveExternalTokenResult | null> => {
	const result = await ResultAsync.fromPromise(
		verify(token, env.JWT_SECRET, "HS256"),
		() => null,
	);
	return result.isOk() ? { props: { accessToken: token } } : null;
};
