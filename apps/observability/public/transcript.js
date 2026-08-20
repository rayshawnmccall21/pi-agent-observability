(() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  function __accessProp(key) {
    return this[key];
  }
  var __toCommonJS = (from) => {
    var entry = (__moduleCache ??= new WeakMap()).get(from),
      desc;
    if (entry) return entry;
    entry = __defProp({}, "__esModule", { value: true });
    if ((from && typeof from === "object") || typeof from === "function") {
      for (var key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(entry, key))
          __defProp(entry, key, {
            get: __accessProp.bind(from, key),
            enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable,
          });
    }
    __moduleCache.set(from, entry);
    return entry;
  };
  var __moduleCache;
  var __returnValue = (v) => v;
  function __exportSetter(name, newValue) {
    this[name] = __returnValue.bind(null, newValue);
  }
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, {
        get: all[name],
        enumerable: true,
        configurable: true,
        set: __exportSetter.bind(all, name),
      });
  };

  // src/browser-api.ts
  var exports_browser_api = {};
  __export(exports_browser_api, {
    TRANSCRIPT_API_VERSION: () => TRANSCRIPT_API_VERSION,
  });

  // src/transcript-preview.ts
  function compactToolOutput(output, limits) {
    const maxLines = Math.max(0, Math.trunc(limits.maxLines));
    const maxChars = Math.max(0, Math.trunc(limits.maxChars));
    const preview = output
      .split(
        `
`,
      )
      .slice(0, maxLines)
      .join(
        `
`,
      )
      .slice(0, maxChars);
    return { text: preview, omitted: preview.length < output.length };
  }
  // src/transcript-search.ts
  function scalarValue(value) {
    if (["number", "boolean", "bigint", "symbol"].includes(typeof value)) {
      return String(value);
    }
    return "";
  }
  function isNullish(value) {
    return value === null || value === undefined;
  }
  function objectSearchValues(value) {
    if (Array.isArray(value)) {
      return value.flatMap(searchableValues);
    }
    return Object.entries(value).flatMap(([key, nested]) => [key, ...searchableValues(nested)]);
  }
  function searchableValues(value) {
    if (typeof value === "string") {
      return [value];
    }
    if (isNullish(value)) {
      return [""];
    }
    return typeof value === "object" ? objectSearchValues(value) : [scalarValue(value)];
  }
  function searchTranscript(items, query) {
    const needle = query.trim().toLocaleLowerCase();
    if (needle === "") {
      return items;
    }
    return items.filter((item) =>
      searchableValues(item)
        .join(
          `
`,
        )
        .toLocaleLowerCase()
        .includes(needle),
    );
  }
  // src/transcript-thinking.ts
  function payloadRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value))
      : undefined;
  }
  function text(value) {
    return typeof value === "string" ? value : "";
  }
  function normalizeThinking(value) {
    return value.trim().replace(/\s+/gu, " ");
  }
  function explicitTurnKey(event) {
    const turnIndex = payloadRecord(event.payload)?.["turn_index"];
    return typeof turnIndex === "string" || typeof turnIndex === "number"
      ? `turn:${String(turnIndex)}`
      : undefined;
  }
  function capturedThinking(event) {
    const payload = payloadRecord(event.payload);
    if (event.type === "assistant_message") {
      return text(payload?.["thinking"]);
    }
    if (event.type === "thinking") {
      return text(payload?.["text"]);
    }
    return "";
  }
  function occurrenceBoundary(event) {
    return ["user_message", "turn_start", "turn_end"].includes(event.type);
  }
  function equivalentAssistant(event, normalized) {
    if (event?.type !== "assistant_message") {
      return;
    }
    return normalizeThinking(capturedThinking(event)) === normalized ? event : undefined;
  }
  function forwardEquivalentAssistant(events, thinkingIndex, normalized) {
    for (const event of events.slice(thinkingIndex + 1)) {
      if (occurrenceBoundary(event)) {
        return;
      }
      if (event.type === "assistant_message") {
        return equivalentAssistant(event, normalized);
      }
    }
    return;
  }
  function standaloneOccurrence(input) {
    const normalized = normalizeThinking(input.captured);
    const assistant =
      equivalentAssistant(input.events[input.index - 1], normalized) ??
      forwardEquivalentAssistant(input.events, input.index, normalized);
    return assistant === undefined
      ? input.event.event_id
      : (explicitTurnKey(assistant) ?? assistant.event_id);
  }
  function thinkingOccurrence(input) {
    return (
      explicitTurnKey(input.event) ??
      input.activeTurn ??
      (input.event.type === "thinking" ? standaloneOccurrence(input) : input.event.event_id)
    );
  }
  function turnBoundary(event, activeTurn) {
    if (event.type === "turn_start") {
      return {
        handled: true,
        activeTurn: explicitTurnKey(event) ?? `turn-event:${event.event_id}`,
      };
    }
    return event.type === "turn_end"
      ? { handled: true, activeTurn: undefined }
      : { handled: false, activeTurn };
  }
  function thinkingOccurrenceKeys(events) {
    const occurrences = new Map();
    let activeTurn;
    for (const [index, event] of events.entries()) {
      const boundary = turnBoundary(event, activeTurn);
      activeTurn = boundary.activeTurn;
      if (boundary.handled) {
        continue;
      }
      const captured = capturedThinking(event);
      if (captured.trim() === "") {
        continue;
      }
      occurrences.set(
        event.event_id,
        thinkingOccurrence({ events, event, index, captured, activeTurn }),
      );
    }
    return occurrences;
  }

  // src/transcript.ts
  function record(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value))
      : undefined;
  }
  function text2(value) {
    return typeof value === "string" ? value : "";
  }
  function identifier(value) {
    return typeof value === "string" || typeof value === "number" ? String(value) : "";
  }
  function ordered(events) {
    return [...events].sort((left, right) => left.seq - right.seq);
  }
  function toolState(call, failed, output) {
    if (call === undefined) {
      return "orphan";
    }
    if (failed) {
      return "error";
    }
    return output === "" ? "empty" : "success";
  }
  function toolKey(call, result) {
    return call === undefined ? `orphan:${result.event_id}` : `tool:${call.event_id}`;
  }
  function toolEvents(call, result) {
    return call === undefined ? [result] : [call, result];
  }
  function toolItem(call, result) {
    const callPayload = record(call?.payload) ?? {};
    const resultPayload = record(result.payload) ?? {};
    const output = text2(resultPayload["content_text"]);
    return {
      kind: "tool",
      key: toolKey(call, result),
      toolCallId: identifier(callPayload["tool_call_id"] ?? resultPayload["tool_call_id"]),
      toolName: text2(callPayload["tool_name"] ?? resultPayload["tool_name"]),
      args: record(callPayload["args"]) ?? {},
      argsTruncated: callPayload["args_truncated"] === true,
      output,
      outputTruncated: resultPayload["content_truncated"] === true,
      state: toolState(call, resultPayload["is_error"] === true, output),
      events: toolEvents(call, result),
    };
  }
  function pendingTool(call) {
    const payload = record(call.payload);
    return {
      kind: "tool",
      key: `tool:${call.event_id}`,
      toolCallId: identifier(payload?.["tool_call_id"]),
      toolName: text2(payload?.["tool_name"]),
      args: record(payload?.["args"]) ?? {},
      argsTruncated: payload?.["args_truncated"] === true,
      output: "",
      outputTruncated: false,
      state: "pending",
      events: [call],
    };
  }
  function toolCallId(event) {
    const value = record(event.payload)?.["tool_call_id"];
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
  }
  function queueToolCall(event, id, state) {
    state.unmatched.set(id, [...(state.unmatched.get(id) ?? []), event]);
  }
  function matchToolResult(event, id, state) {
    const call = state.unmatched.get(id)?.shift();
    if (call !== undefined) {
      state.matches.set(call, event);
    }
  }
  var TOOL_CORRELATION_HANDLERS = {
    tool_call: queueToolCall,
    tool_result: matchToolResult,
  };
  function correlatedTools(events) {
    const state = { unmatched: new Map(), matches: new Map() };
    for (const event of events) {
      const id = toolCallId(event);
      if (id !== undefined) {
        TOOL_CORRELATION_HANDLERS[event.type]?.(event, id, state);
      }
    }
    return state.matches;
  }
  function thinkingDeduplicationKey(event, captured, state) {
    return `${state.thinkingOccurrences.get(event.event_id) ?? event.event_id}\x00${normalizeThinking(captured)}`;
  }
  function addAssistant(event, payload, state) {
    const exposed = text2(payload?.["thinking"]);
    const deduplicationKey = thinkingDeduplicationKey(event, exposed, state);
    if (exposed.trim() !== "" && !state.capturedThinking.has(deduplicationKey)) {
      state.capturedThinking.add(deduplicationKey);
      state.items.push({
        kind: "thinking",
        key: `${event.event_id}:thinking`,
        text: exposed.trim(),
        events: [event],
      });
    }
    const answer = text2(payload?.["text"]);
    if (answer.trim() !== "") {
      state.items.push({ kind: "assistant", key: event.event_id, text: answer, events: [event] });
    }
  }
  function addCaptured(event, state, kind) {
    const captured = text2(record(event.payload)?.["text"]);
    if (captured.trim() === "") {
      return;
    }
    if (kind === "thinking") {
      const deduplicationKey = thinkingDeduplicationKey(event, captured, state);
      if (state.capturedThinking.has(deduplicationKey)) {
        return;
      }
      state.capturedThinking.add(deduplicationKey);
      state.items.push({ kind, key: event.event_id, text: captured.trim(), events: [event] });
    } else {
      state.items.push({ kind, key: event.event_id, text: captured, events: [event] });
    }
  }
  function addCall(event, state) {
    const result = state.matches.get(event);
    state.items.push(result === undefined ? pendingTool(event) : toolItem(event, result));
  }
  function addResult(event, state) {
    if (!state.resultIds.has(event.event_id)) {
      state.items.push(toolItem(undefined, event));
    }
  }
  function addStart(event, state) {
    if (text2(record(event.payload)?.["prompt"]).trim() !== "") {
      state.fallback ??= event;
    }
  }
  var EVENT_HANDLERS = {
    agent_start: addStart,
    ["user_message"]: (event, state) => {
      addCaptured(event, state, "user");
    },
    thinking: (event, state) => {
      addCaptured(event, state, "thinking");
    },
    tool_call: addCall,
    tool_result: addResult,
    ["assistant_message"]: (event, state) => {
      addAssistant(event, record(event.payload), state);
    },
  };
  function addEvent(event, state) {
    EVENT_HANDLERS[event.type]?.(event, state);
  }
  function addFallback(state) {
    if (state.items.some((item) => item.kind === "user") || state.fallback === undefined) {
      return;
    }
    state.items.unshift({
      kind: "user",
      key: `${state.fallback.event_id}:prompt`,
      text: text2(record(state.fallback.payload)?.["prompt"]),
      events: [state.fallback],
    });
  }
  function projectTranscript(events) {
    const sorted = ordered(events);
    const matches = correlatedTools(sorted);
    const state = {
      items: [],
      capturedThinking: new Set(),
      thinkingOccurrences: thinkingOccurrenceKeys(sorted),
      matches,
      resultIds: new Set(Array.from(matches.values(), (event) => event.event_id)),
    };
    for (const event of sorted) {
      addEvent(event, state);
    }
    addFallback(state);
    return state.items;
  }

  // src/browser-api.ts
  var TRANSCRIPT_API_VERSION = 1;
  globalThis.OBS_TRANSCRIPT = Object.freeze({
    version: TRANSCRIPT_API_VERSION,
    projectTranscript,
    compactToolOutput,
    searchTranscript,
  });
})();
