import {
	err,
	errAsync,
	ok,
	okAsync,
	type Result,
	type ResultAsync,
} from "neverthrow";

import type { DataLayer, DataLayerError } from "@/lib/data";
import { AppHTTPException, ErrorCodes } from "@/lib/errors";
import {
	collectMediaIds,
	getMediaFields,
	getMediaIdsFromValue,
	isValidMediaArray,
	isValidMediaObject,
	validateContentData,
} from "@/lib/schema";

export const validateContentOrFail = (input: {
	data: Record<string, unknown>;
	schema: Record<string, unknown>;
}): Result<void, AppHTTPException> => {
	const validation = validateContentData({
		data: input.data,
		schema: input.schema,
	});

	if (validation.isErr()) {
		return err(
			new AppHTTPException({
				code: ErrorCodes.VALIDATION_FAILED,
				message: "Content validation failed",
				status: 400,
				cause: validation.error,
			}),
		);
	}

	return ok(undefined);
};

type MediaRow = { id: string; r2Key: string };

/**
 * Rewrites the `path` of every media reference in `items` to the media
 * record's r2Key, so a stale or bogus client-supplied path cannot persist.
 */
const normalizeMediaPaths = (input: {
	items: Record<string, unknown>[];
	mediaFields: Array<{ field: string; isMany: boolean }>;
	rows: MediaRow[];
}): void => {
	const pathById = new Map(input.rows.map((r) => [r.id, r.r2Key]));

	for (const item of input.items) {
		for (const { field, isMany } of input.mediaFields) {
			const value = item[field];
			if (value === undefined) {
				continue;
			}

			if (isMany) {
				item[field] = (value as Array<{ id: string; path: string }>).map(
					(ref) => ({ ...ref, path: pathById.get(ref.id) ?? ref.path }),
				);
			} else {
				const ref = value as { id: string; path: string };
				item[field] = { ...ref, path: pathById.get(ref.id) ?? ref.path };
			}
		}
	}
};

export const validateMediaFieldsOrFail = (input: {
	data: Record<string, unknown>;
	schema: Record<string, unknown>;
	DL: DataLayer;
}): ResultAsync<void, AppHTTPException | DataLayerError> => {
	const mediaFields = getMediaFields({ schema: input.schema });

	if (mediaFields.length === 0) {
		return okAsync(undefined);
	}

	const invalidFields: string[] = [];

	for (const { field, isMany } of mediaFields) {
		const value = input.data[field];
		if (value === undefined) {
			continue;
		}

		const isValid = isMany
			? isValidMediaArray({ value })
			: isValidMediaObject({ value });

		if (!isValid) {
			invalidFields.push(field);
		}
	}

	if (invalidFields.length > 0) {
		return errAsync(
			new AppHTTPException({
				code: ErrorCodes.VALIDATION_FAILED,
				message: `Media fields must be objects with { id: "med_...", path: string }: ${invalidFields.join(", ")}`,
				status: 400,
			}),
		);
	}

	const mediaIds = collectMediaIds({
		data: input.data,
		schema: input.schema,
	});

	return input.DL.media.getMediaByIds({ ids: mediaIds }).andThen((rows) => {
		const foundIds = new Set(rows.map((r) => r.id));
		const missing = mediaIds.filter((id) => !foundIds.has(id));

		if (missing.length > 0) {
			return errAsync(
				new AppHTTPException({
					code: ErrorCodes.VALIDATION_FAILED,
					message: `Media not found: ${missing.join(", ")}`,
					status: 400,
				}),
			);
		}

		normalizeMediaPaths({ items: [input.data], mediaFields, rows });

		return okAsync(undefined);
	});
};

export const validateMediaFieldsForBatch = (input: {
	items: Record<string, unknown>[];
	schema: Record<string, unknown>;
	DL: DataLayer;
}): ResultAsync<void, AppHTTPException | DataLayerError> => {
	const mediaFields = getMediaFields({ schema: input.schema });

	if (mediaFields.length === 0) {
		return okAsync(undefined);
	}

	const invalidFields: string[] = [];
	const mediaIds = new Set<string>();

	for (const item of input.items) {
		for (const { field, isMany } of mediaFields) {
			const value = item[field];
			if (value === undefined) {
				continue;
			}

			const isValid = isMany
				? isValidMediaArray({ value })
				: isValidMediaObject({ value });

			if (!isValid) {
				invalidFields.push(field);
				continue;
			}

			for (const id of getMediaIdsFromValue({ value })) {
				mediaIds.add(id);
			}
		}
	}

	if (invalidFields.length > 0) {
		return errAsync(
			new AppHTTPException({
				code: ErrorCodes.VALIDATION_FAILED,
				message: `Media fields must be objects with { id: "med_...", path: string }: ${invalidFields.join(", ")}`,
				status: 400,
			}),
		);
	}

	if (mediaIds.size === 0) {
		return okAsync(undefined);
	}

	return input.DL.media
		.getMediaByIds({ ids: Array.from(mediaIds) })
		.andThen((rows) => {
			const foundIds = new Set(rows.map((r) => r.id));
			const missing = Array.from(mediaIds).filter((id) => !foundIds.has(id));

			if (missing.length > 0) {
				return errAsync(
					new AppHTTPException({
						code: ErrorCodes.VALIDATION_FAILED,
						message: `Media not found: ${missing.join(", ")}`,
						status: 400,
					}),
				);
			}

			normalizeMediaPaths({ items: input.items, mediaFields, rows });

			return okAsync(undefined);
		});
};
