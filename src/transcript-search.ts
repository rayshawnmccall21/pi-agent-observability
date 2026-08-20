import type { TranscriptItem } from "./transcript-types.js";

function scalarValue(value: unknown): string {
  if (["number", "boolean", "bigint", "symbol"].includes(typeof value)) {
    return String(value);
  }
  return "";
}

function isNullish(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

function objectSearchValues(value: object): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(searchableValues);
  }
  return Object.entries(value).flatMap(([key, nested]) => [key, ...searchableValues(nested)]);
}

function searchableValues(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (isNullish(value)) {
    return [""];
  }
  return typeof value === "object" ? objectSearchValues(value) : [scalarValue(value)];
}

/**
 * Filters transcript items against their complete captured searchable content.
 * @param items - Transcript items to search.
 * @param query - Case-insensitive query to match.
 *
 * @returns Matching items, or the original collection for a blank query.
 *
 * @example `searchTranscript(items, "permission denied")`
 */
export function searchTranscript(
  items: readonly TranscriptItem[],
  query: string,
): readonly TranscriptItem[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") {
    return items;
  }
  return items.filter((item) =>
    searchableValues(item).join("\n").toLocaleLowerCase().includes(needle),
  );
}
