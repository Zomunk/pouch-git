import { describe, expect, it } from "vitest";

import {
	createCollection,
	createContent,
	createMedia,
	fetchWorker,
	readerToken,
	writerToken,
} from "../utils.js";
import { env } from "cloudflare:test";

describe("media", () => {
	describe("GET /media/:id/file", () => {
		it("serves the uploaded file content", async () => {
			const file = new File(["file content"], "serve.txt", {
				type: "text/plain",
			});
			const created = await createMedia(file);

			const readToken = await readerToken();
			const response = await fetchWorker(
				`/media/${created.id}/file`,
				{},
				readToken,
			);

			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe("text/plain");
			expect(await response.text()).toBe("file content");
		});
	});

	describe("DELETE /media/:id", () => {
		it("refuses to delete media referenced by content", async () => {
			await createCollection({
				slug: "posts",
				name: "Posts",
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

			const token = await writerToken();
			const file = new File(["cover"], "cover.png", { type: "image/png" });
			const media = await createMedia(file);

			await createContent("posts", {
				data: { title: "Post", cover: { id: media.id, path: media.r2Key } },
			});

			const deleteResponse = await fetchWorker(
				`/media/${media.id}`,
				{ method: "DELETE" },
				token,
			);

			expect(deleteResponse.status).toBe(409);
			const body = (await deleteResponse.json()) as { code: string };
			expect(body.code).toBe("MEDIA_IN_USE");

			const row = await env.DB.prepare("SELECT * FROM media WHERE id = ?")
				.bind(media.id)
				.first();
			expect(row).not.toBeNull();

			const object = await env.MEDIA_BUCKET.get(media.r2Key);
			expect(object).not.toBeNull();
		});
	});
});
