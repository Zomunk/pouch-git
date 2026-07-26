import { describe, expect, it } from "vitest";

import {
	adminToken,
	createCollection,
	createContent,
	createMedia,
	fetchWorker,
} from "../utils.js";

describe("collections", () => {
	describe("POST /collections", () => {
		it("returns every validation error in cause, not just the first", async () => {
			const token = await adminToken();
			const response = await fetchWorker(
				"/collections",
				{
					method: "POST",
					body: JSON.stringify({ bogus: true }),
				},
				token,
			);

			expect(response.status).toBe(400);

			const body = (await response.json()) as {
				code: string;
				cause: Array<{ path: string; message: string }>;
			};
			expect(body.code).toBe("VALIDATION_FAILED");
			expect(Array.isArray(body.cause)).toBe(true);
			expect(body.cause.length).toBeGreaterThan(1);
			expect(body.cause[0]).toHaveProperty("message");
		});
	});

	describe("PATCH /collections/:slug/schema", () => {
		it("allows safe additive changes without force", async () => {
			const collection = await createCollection({
				slug: "articles",
				name: "Articles",
				schema: {
					type: "object",
					properties: {
						title: { type: "string" },
					},
					required: ["title"],
					additionalProperties: false,
				},
			});

			const token = await adminToken();
			const response = await fetchWorker(
				"/collections/articles/schema",
				{
					method: "PATCH",
					body: JSON.stringify({
						schema: {
							type: "object",
							properties: {
								title: { type: "string" },
								description: { type: "string" },
							},
							required: ["title"],
							additionalProperties: false,
						},
					}),
				},
				token,
			);

			expect(response.status).toBe(200);

			const body = (await response.json()) as {
				currentSchemaVersionId: string;
				schema: Record<string, unknown>;
			};

			expect(body.currentSchemaVersionId).not.toBe(
				collection.currentSchemaVersionId,
			);
			expect(body.schema.properties).toHaveProperty("description");
		});

		it("blocks destructive changes unless force=true", async () => {
			await createCollection({
				slug: "pages",
				name: "Pages",
				schema: {
					type: "object",
					properties: {
						title: { type: "string" },
					},
					required: ["title"],
					additionalProperties: false,
				},
			});

			const token = await adminToken();
			const response = await fetchWorker(
				"/collections/pages/schema",
				{
					method: "PATCH",
					body: JSON.stringify({
						schema: {
							type: "object",
							properties: {
								title: { type: "number" },
							},
							required: ["title"],
							additionalProperties: false,
						},
					}),
				},
				token,
			);

			expect(response.status).toBe(409);

			const body = (await response.json()) as { code: string };
			expect(body.code).toBe("COLLECTION_SCHEMA_FORCE_REQUIRED");
		});
	});

	describe("DELETE /collections/:slug", () => {
		it("force-deleting a collection deletes its content, freeing referenced media", async () => {
			await createCollection({
				slug: "force-delete-cascade",
				name: "Force Delete Cascade",
				schema: {
					type: "object",
					properties: {
						title: { type: "string" },
						cover: { type: "object", "x-media": true },
					},
					required: ["title"],
					additionalProperties: false,
				},
			});

			const media = await createMedia(
				new File(["img"], "cover.png", { type: "image/png" }),
			);
			await createContent("force-delete-cascade", {
				data: { title: "A", cover: { id: media.id, path: media.r2Key } },
			});

			const token = await adminToken();
			const deleteResponse = await fetchWorker(
				"/collections/force-delete-cascade?force=true",
				{ method: "DELETE" },
				token,
			);
			expect(deleteResponse.status).toBe(204);

			const mediaResponse = await fetchWorker(
				`/media/${media.id}`,
				{ method: "DELETE" },
				token,
			);
			expect(mediaResponse.status).toBe(204);
		});
	});
});
