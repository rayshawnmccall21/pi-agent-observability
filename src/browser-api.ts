import { compactToolOutput, projectTranscript, searchTranscript } from "./transcript.js";

/** Version of the browser transcript API contract. */
export const TRANSCRIPT_API_VERSION = 1;

/** Immutable transcript API exposed to classic browser scripts. */
export interface TranscriptBrowserApi {
  /** Contains the browser API contract version. */
  readonly version: typeof TRANSCRIPT_API_VERSION;
  /** Projects captured events into transcript items. */
  readonly projectTranscript: typeof projectTranscript;
  /** Produces bounded tool-output previews. */
  readonly compactToolOutput: typeof compactToolOutput;
  /** Searches complete transcript content. */
  readonly searchTranscript: typeof searchTranscript;
}

declare global {
  /** Exposes the immutable transcript API to classic browser scripts. */
  var OBS_TRANSCRIPT: TranscriptBrowserApi;
}

globalThis.OBS_TRANSCRIPT = Object.freeze({
  version: TRANSCRIPT_API_VERSION,
  projectTranscript,
  compactToolOutput,
  searchTranscript,
});
