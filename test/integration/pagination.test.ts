import { describe, expect, it } from "vitest";

import {
	createCollection,
	createContent,
	fetchWorker,
	readerToken,
} from "../utils.js";

const makeSchema = () => ({
	type: "object",
	properties: {
		title: { type: "string" },
	},
	required: ["title"],
	additionalProperties: false,
});

type Page = {
	data: Array<{ data: Record<string, unknown> }>;
	nextCursor: string | null;
	prevCursor: string | null;
};

const titles = (body: Page) => body.data.map((item) => item.data.title);

const getPage = async (slug: string, query: string, token: string) => {
	const response = await fetchWorker(
		`/collections/${slug}/content${query}`,
		{},
		token,
	);
	expect(response.status).toBe(200);
	return (await response.json()) as Page;
};

describe("pagination", () => {
	it("pages forward and backward through the default order", async () => {
		await createCollection({
			slug: "paginate-default",
			name: "Paginate Default",
			schema: makeSchema(),
		});

		await createContent("paginate-default", { data: { title: "A" } });
		await createContent("paginate-default", { data: { title: "B" } });
		await createContent("paginate-default", { data: { title: "C" } });

		const token = await readerToken();

		const page1 = await getPage("paginate-default", "?limit=2", token);
		expect(titles(page1)).toEqual(["C", "B"]);
		expect(page1.prevCursor).toBeNull();
		expect(page1.nextCursor).not.toBeNull();

		const page2 = await getPage(
			"paginate-default",
			`?limit=2&cursor=${page1.nextCursor}`,
			token,
		);
		expect(titles(page2)).toEqual(["A"]);
		expect(page2.nextCursor).toBeNull();
		expect(page2.prevCursor).not.toBeNull();

		const back = await getPage(
			"paginate-default",
			`?limit=2&direction=backward&cursor=${page2.prevCursor}`,
			token,
		);
		expect(titles(back)).toEqual(["C", "B"]);
		expect(back.prevCursor).toBeNull();
		expect(back.nextCursor).not.toBeNull();

		const forwardAgain = await getPage(
			"paginate-default",
			`?limit=2&cursor=${back.nextCursor}`,
			token,
		);
		expect(titles(forwardAgain)).toEqual(["A"]);
	});

	it("pages backward through a sorted query", async () => {
		await createCollection({
			slug: "paginate-sorted",
			name: "Paginate Sorted",
			schema: makeSchema(),
		});

		await createContent("paginate-sorted", { data: { title: "A" } });
		await createContent("paginate-sorted", { data: { title: "B" } });
		await createContent("paginate-sorted", { data: { title: "C" } });

		const token = await readerToken();

		const page1 = await getPage(
			"paginate-sorted",
			"?sort=createdAt&limit=2",
			token,
		);
		expect(titles(page1)).toEqual(["A", "B"]);
		expect(page1.prevCursor).toBeNull();

		const page2 = await getPage(
			"paginate-sorted",
			`?sort=createdAt&limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`,
			token,
		);
		expect(titles(page2)).toEqual(["C"]);
		expect(page2.prevCursor).not.toBeNull();

		const back = await getPage(
			"paginate-sorted",
			`?sort=createdAt&limit=2&direction=backward&cursor=${encodeURIComponent(page2.prevCursor!)}`,
			token,
		);
		expect(titles(back)).toEqual(["A", "B"]);
		expect(back.prevCursor).toBeNull();
	});

	it("requires a cursor when direction=backward", async () => {
		await createCollection({
			slug: "paginate-no-cursor",
			name: "Paginate No Cursor",
			schema: makeSchema(),
		});

		const token = await readerToken();
		const response = await fetchWorker(
			"/collections/paginate-no-cursor/content?direction=backward",
			{},
			token,
		);
		expect(response.status).toBe(400);
	});

	it("rejects an invalid direction", async () => {
		await createCollection({
			slug: "paginate-bad-direction",
			name: "Paginate Bad Direction",
			schema: makeSchema(),
		});

		const token = await readerToken();
		const response = await fetchWorker(
			"/collections/paginate-bad-direction/content?direction=sideways",
			{},
			token,
		);
		expect(response.status).toBe(400);
	});
});
