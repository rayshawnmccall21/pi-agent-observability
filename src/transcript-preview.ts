import type { CompactToolLimits, CompactToolPreview } from "./transcript-types.js";

/**
 * Creates a tool-output prefix bounded by line and character limits.
 * @param output - Complete captured tool output.
 * @param limits - Line and character limits for the preview.
 *
 * @returns The bounded prefix and its omission indicator.
 *
 * @example `compactToolOutput("first\nsecond", { maxLines: 1, maxChars: 80 })`
 */
export function compactToolOutput(output: string, limits: CompactToolLimits): CompactToolPreview {
  const maxLines = Math.max(0, Math.trunc(limits.maxLines));
  const maxChars = Math.max(0, Math.trunc(limits.maxChars));
  const preview = output.split("\n").slice(0, maxLines).join("\n").slice(0, maxChars);
  return { text: preview, omitted: preview.length < output.length };
}
