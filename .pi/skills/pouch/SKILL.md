---
name: pouch
description: Use when working with a pouch headless CMS instance — creating collections and schemas, reading/writing content, filtering queries, uploading media, minting API keys, or connecting an MCP client to its /mcp endpoint.
---

# pouch CMS

API-first headless CMS on Cloudflare (Workers + D1). No admin UI — the HTTP API (or the MCP endpoint) is the product. All requests below assume a base URL like `https://<your-pouch>.workers.dev` (substitute the real one; store it as e.g. `POUCH_URL`).

## Authentication

Everything except `POST /auth/keys`, `/docs`, and the OAuth flow requires a JWT:

```
Authorization: Bearer <token>
```

Mint a key with the operator's shared `JWT_SECRET` (operator-provisioned; pouch has no key-listing or revocation — expiry is the lifecycle):

```bash
curl -X POST $POUCH_URL/auth/keys \
  -H 'Content-Type: application/json' \
  -d '{
    "secret": "<JWT_SECRET>",
    "name": "my-app",
    "scopes": ["collection:read", "content:read", "content:write"],
    "collections": ["posts"],
    "expiresInSeconds": 7776000
  }'
# → { "token": "...", "jti": "key_...", "scopes": [...], "exp": ... }
```

- Seven scopes: `collection:read|write`, `content:read|write`, `media:read|write`, `audit:read`. Endpoint group ↔ scope name matches the URL (`/media` → `media:*`, `/audit-logs` → `audit:read`, `/collections` → `collection:*`, `/collections/:slug/content` → `content:*`).
- Content routes need `collection:read` **in addition to** the content scope — a key with only `content:*` gets 403.
- `collections` (optional) confines the key to those slugs. Absent = all collections. `GET /collections` is filtered rather than 403'd; slug routes outside the claim are 403.
- `expiresInSeconds` is optional (min 60, default 6 months).
- Rate limit: 100 req / 10 s per key → 429 `RATE_LIMITED`.
- `GET /openapi.json` (requires `collection:read`) is the live, dynamic API reference — fetch it when you need per-collection endpoint/schema details. `/docs` serves a Scalar UI behind Basic Auth.

## IDs

Prefixed UUIDv7: `col_` collection, `con_` content, `sch_` schema version, `med_` media, `key_` API key, `aud_` audit entry. Time-sortable. Route params pattern-match the prefix — a malformed id is a 400.

## Collections

```bash
POST   /collections                    # { slug, name, schema, titleField? } → 201
GET    /collections                    # → bare array [{ id, slug, name, titleField }]
GET    /collections/:slug              # → { ..., currentSchemaVersionId, schema }
GET    /collections/:slug/schema       # raw JSON Schema
PATCH  /collections/:slug/schema       # { schema, force? }
DELETE /collections/:slug?force=true   # 204; 409 without force if it has content
```

- `schema` is standard JSON Schema (draft 2020-12), stored as-is.
- **Property keys are immutable.** To change a display name, set `x-label` (mutable, non-destructive). A real rename = remove + add, which is destructive.
- Destructive changes (removed or retyped fields) without `force: true` → **409** `COLLECTION_SCHEMA_FORCE_REQUIRED` listing the affected fields.
- `force: true` only changes the schema — **existing content rows keep their old data** (removed fields linger as orphaned keys, ignored by validation of new writes). To migrate data, PATCH each record yourself.

### Field types (the five `x-` keywords)

```jsonc
{ "type": "string" }                                          // text
{ "type": "string", "x-widget": "richtext" }                  // richtext
{ "type": "number" }                                          // integer → "integer"
{ "type": "boolean" }
{ "type": "string", "format": "date" }                        // date
{ "type": "string", "enum": ["draft", "published"] }          // select
{ "type": "string", "x-relation": "authors" }                 // relation (single, stores con_ id)
{ "type": "array", "items": { "type": "string" }, "x-relation": "authors" }  // relation (many)
{ "type": "number", "x-index": true }                         // indexed for filtering (scalars only)
{ "type": "object", "x-media": true }                         // media (single)
{ "type": "array", "items": { "type": "object" }, "x-media": true }          // media (many)
{}                                                            // arbitrary JSON
```

`x-label` = mutable display name; `x-widget` = authoring hint (`"richtext"` only); `x-index` builds an expression index so the field filters efficiently.

## Content

Mounted at `/collections/:slug/content`.

```bash
GET    /collections/:slug/content              # list: ?limit= ?cursor= ?resolve= ?field[op]=
POST   /collections/:slug/content              # { data, status? } → 201. status: draft|published|archived (default draft)
POST   /collections/:slug/content/batch        # { items: [{data, status?}] } 1–100 → 201 { data: [...] }
PATCH  /collections/:slug/content/batch        # { items: [{ id, data?, status? }] } 1–100
DELETE /collections/:slug/content/batch        # { ids: ["con_..."] } 1–100 → 204
GET    /collections/:slug/content/:id          # ?resolve= works here too
PATCH  /collections/:slug/content/:id          # { data?, status? } — data merges into existing data
DELETE /collections/:slug/content/:id          # 204
POST   /collections/:slug/content:validate     # dry-run validation: { data, status? }
```

Content record shape: `{ id, collectionId, data, status, schemaVersionId, createdAt, updatedAt }` (timestamps are epoch ms numbers). `status` is a top-level field, **not** part of `data`.

### Filtering

Only **schema fields** (keys inside `data`) are filterable — `?field=value` (equality) or `?field[op]=value`. Top-level record fields (`status`, `createdAt`, `id`) are **not** filterable; `?status=published` → 400 `Unknown filter field`.

Operators allowed depend on the field's schema type:

- `number`/`integer`: `eq ne gt gte lt lte in nin`
- `boolean`: `eq ne in nin`
- `string` with `format: "date"`: all eight
- other `string`: `eq ne in nin`
- `array`/`object`: not filterable

```bash
curl --globoff "$POUCH_URL/collections/posts/content?views[gt]=100&tag[in]=a,b,c" \
  -H "Authorization: Bearer $TOKEN"
```

`in`/`nin` values are comma-separated. Values coerce to number/boolean per schema type. Unknown field or operator → 400. (curl needs `--globoff` for the `[op]` brackets.)

### Sorting and pagination

No sort parameter. Lists come back **newest first** (descending UUIDv7 id); `?cursor=` pages through that order. Envelope: `{ data: [...], nextCursor: string | null }` — `?limit=` default 50, max 500; `?cursor=` is the id of the last item from the previous page; `nextCursor: null` = done. (`GET /collections` is the exception: a bare array.)

### Resolving relations and media

`?resolve=author,cover` expands `x-relation`/`x-media` fields inline. Any other field name → 400.

## Media

```bash
POST   /media            # multipart/form-data, single file under field name "file". Max 100 MB. → 201, full record
GET    /media            # ?limit= ?cursor= → { data, nextCursor }
GET    /media/:id        # record: { id, r2Key, filename, mimeType, sizeBytes, status, createdAt, updatedAt }
GET    /media/:id/file   # streams raw bytes with original content-type
DELETE /media/:id        # 204; 409 MEDIA_IN_USE while any content references it
```

To use media in content:

1. `POST /media` (multipart) → get the `med_...` id and `r2Key`.
2. Store `{ "id": "med_...", "path": "<r2Key>" }` in the `x-media` field (array of those for many). `path` is stored verbatim and **not validated** — on reads it is returned as `MEDIA_PUBLIC_URL + "/" + path`, so use the `r2Key` when `MEDIA_PUBLIC_URL` fronts the media bucket. Wrong shape or unknown `med_` id → 400 on write.
3. Prefer `?resolve=<field>` for display: it replaces the reference with `{ id, url, filename, mimeType, sizeBytes }` where `url` is authoritative (`MEDIA_PUBLIC_URL + r2Key`), regardless of the stored `path`.

## MCP endpoint

`POST /mcp` — Streamable HTTP transport, stateless (no session ids). Two auth options:

- **OAuth 2.1 + PKCE** (what MCP clients do automatically): DCR at `POST /register`, consent at `/authorize`, token at `/token`. Public clients only; registrations expire after 90 days.
- **Plain pouch JWT** in `Authorization: Bearer` — same token as the REST API. Unauthenticated requests get `401 invalid_token`.

Client config example (Claude Desktop / Cursor, via `mcp-remote`):

```json
{
  "mcpServers": {
    "pouch": {
      "command": "npx",
      "args": ["mcp-remote", "https://<your-pouch>.workers.dev/mcp",
               "--header", "Authorization: Bearer <token>"]
    }
  }
}
```

Tools are generated from the OpenAPI doc: static tools (`list_collections`, `create_collection`, `get_collection_schema_by_slug`, `patch_collection_schema`, `list_media`, `create_media`, `list_audit_logs`, …) plus a per-collection set (`list_posts_content`, `create_posts_content`, `get_posts_content_by_id`, `update_posts_content`, `validate_posts_content`, batch variants, …). Key minting (`/auth`) is deliberately not exposed as a tool. Tools for collections outside the token's `collections` claim are hidden from `tools/list`.

## Errors

Always JSON, including 404s:

```json
{ "code": "VALIDATION_FAILED", "message": "...", "status": 400, "cause": ... }
```

Common codes: `UNAUTHORIZED` (no/bad token), 403 `Missing required scopes: ...`, `NOT_FOUND`, `VALIDATION_FAILED` (content-schema failures carry field details in `cause`), `COLLECTION_SLUG_EXISTS`, `COLLECTION_SCHEMA_FORCE_REQUIRED` (409), `MEDIA_IN_USE` (409), `RATE_LIMITED` (429).

## Common mistakes

- **403 on content routes despite `content:read`** — content routes also require `collection:read`. Mint keys with both.
- **Filtering `?status=published` or `?sort=...`** — only schema fields filter, and there is no sort param (newest first, always). Model status-like filtering as a schema field if you need it.
- **Sending unknown body keys** — request bodies are `additionalProperties: false`; extra keys (e.g. `id` on create) are a 400.
- **Filtering an array/object field** — not filterable at all; add a scalar `x-index` field instead.
- **`?resolve=` on a plain field** — only `x-relation`/`x-media` fields resolve; anything else is a 400.
- **Uploading media as JSON/base64** — must be multipart form-data with field name `file`.
- **curl eating `?views[gt]=100`** — brackets are glob characters; use `curl --globoff`.
- **Expecting a 200 with a body from DELETE** — deletes return 204 with an empty body.
- **Guessing schemas** — fetch `GET /collections/:slug/schema` or `/openapi.json` instead of assuming field shapes.
- **Blind writes** — use `POST /collections/:slug/content:validate` to check a payload before creating/updating.
