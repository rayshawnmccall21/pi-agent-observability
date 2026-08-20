/** Public transcript projection API. */
export { compactToolOutput, projectTranscript, searchTranscript } from "./transcript.js";
export { TRANSCRIPT_API_VERSION } from "./browser-api.js";

export type { TranscriptBrowserApi } from "./browser-api.js";
export type {
  AssistantTranscriptItem,
  CompactToolLimits,
  CompactToolPreview,
  ThinkingTranscriptItem,
  ToolState,
  ToolTranscriptItem,
  TranscriptItem,
  UserTranscriptItem,
} from "./transcript.js";
