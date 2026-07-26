import { describe, expect, it } from "vitest";

import { createCollection, fetchWorker, readerToken } from "../utils.js";

describe("read replication bookmark header", () => {
	it("returns x-d1-bookmark only when a bookmark is provided", async () => {
		await createCollection({
			slug: "bookmark-test",
			name: "Bookmark Test",
			schema: {
				type: "object",
				properties: {
					title: { type: "string" },
				},
				required: ["title"],
				additionalProperties: false,
			},
		});

		const token = await readerToken();

		const withBookmark = await fetchWorker(
			"/collections/bookmark-test/content",
			{
				headers: {
					"x-d1-bookmark": "first-unconstrained",
				},
			},
			token,
		);
		expect(withBookmark.status).toBe(200);
		expect(withBookmark.headers.get("x-d1-bookmark")).toBeTruthy();

		const withoutBookmark = await fetchWorker(
			"/collections/bookmark-test/content",
			{},
			token,
		);
		expect(withoutBookmark.status).toBe(200);
		expect(withoutBookmark.headers.get("x-d1-bookmark")).toBeNull();
	});
});
