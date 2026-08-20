import type { ObsEvent } from "../shared/types.js";

interface TranscriptBase {
  /** Stable key derived from captured event identity. */
  key: string;
  /** Source events retained without mutation. */
  events: readonly ObsEvent[];
}

/** A captured user message. */
export interface UserTranscriptItem extends TranscriptBase {
  /** Identifies a user item. */
  kind: "user";
  /** Contains the captured user text. */
  text: string;
}

/** A provider-exposed thinking message. */
export interface ThinkingTranscriptItem extends TranscriptBase {
  /** Identifies a thinking item. */
  kind: "thinking";
  /** Contains the captured thinking text. */
  text: string;
}

/** A captured assistant answer. */
export interface AssistantTranscriptItem extends TranscriptBase {
  /** Identifies an assistant item. */
  kind: "assistant";
  /** Contains the captured assistant text. */
  text: string;
}

/** Deterministic state of a projected tool occurrence. */
export type ToolState = "pending" | "success" | "error" | "empty" | "orphan";

/** A tool call occurrence correlated with at most one result. */
export interface ToolTranscriptItem extends TranscriptBase {
  /** Identifies a tool item. */
  kind: "tool";
  /** Contains the provider tool-call identifier. */
  toolCallId: string;
  /** Contains the captured tool name. */
  toolName: string;
  /** Contains the captured tool arguments. */
  args: Readonly<Record<string, unknown>>;
  /** Indicates whether the producer truncated the arguments. */
  argsTruncated: boolean;
  /** Contains the complete captured tool output. */
  output: string;
  /** Indicates whether the producer truncated the output. */
  outputTruncated: boolean;
  /** Describes the correlated tool occurrence state. */
  state: ToolState;
}

/** Public discriminated union returned by transcript projection. */
export type TranscriptItem =
  UserTranscriptItem | ThinkingTranscriptItem | AssistantTranscriptItem | ToolTranscriptItem;

/** Limits applied only to a compact tool preview. */
export interface CompactToolLimits {
  /** Sets the maximum number of preview lines. */
  maxLines: number;
  /** Sets the maximum number of preview characters. */
  maxChars: number;
}

/** A bounded tool-output preview. */
export interface CompactToolPreview {
  /** Contains the bounded output prefix. */
  text: string;
  /** Indicates whether output was omitted from the preview. */
  omitted: boolean;
}
