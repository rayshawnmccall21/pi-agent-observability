# Pi Observability — v2 Frontend + Swimlane

> Goal: make the browser UI **feature-complete** for live + replay, and add a
> **per-agent swimlane view** so you can watch multiple concurrent pi sessions
> side-by-side as their events stream in.

## What ships in v2

1. View toggle in the header: **Single** ↔ **Swimlane**.
2. Single-mode upgrades:
   - **Current behavior:** Single defaults to a content-first Transcript with complete wrapped captured messages, provider-exposed thinking, and ID-correlated tool states. Raw Events remains deep-linkable with `trace=raw` and displays complete envelopes.
   - Transcript controls toggle captured thinking and compact/full tools (Ctrl+T/Ctrl+O); global shortcuts do not intercept native interactive controls.
   - Rich per-type Raw rendering (user/assistant text, tool_call args, tool_result content w/ exit code, thinking italics, model_change cyan banner).
   - Event-type filter chips inside the event view (multi-select; AND with search).
   - Search box: substring match on payload text + tool names.
   - Auto-scroll toggle that pauses when user scrolls up, resumes on "jump to bottom".
   - Keyboard nav: `j/k` next/prev, `Enter` or `Space` expand, `Esc` collapse, `g` jump-to-top, `G` jump-to-bottom.
   - Header shows `last event Ns ago` ticker so a dead session is obvious.
3. Swimlane mode:
   - Sidebar becomes a **multi-select** list (checkbox per session). Up to 6 lanes by default; show "+N more" with horizontal scroll if more selected.
   - Main pane is a horizontal flex of N vertical columns, one per selected session.
   - Each column has a sticky header showing `agent_name · model · pool · last-event-ago` and a small live dot.
   - Each column auto-scrolls (with per-column pause-on-scroll-up).
   - "Auto-add new sessions" toggle: when on, any session matching pool/tag filters that appears mid-stream is added as a new lane.
   - One global SSE connection (no `session_id` filter); client routes by `event.session_id`.
4. Connection robustness:
   - Reconnect with exponential backoff.
   - On reconnect, **resync** Single and open sibling lanes by paging `/sessions/:id/events?since_seq=<lastSeen>` forward, deduplicating by `event_id`, and numeric-sorting before rendering.
   - Single guards reconnect hydration by stream generation and selected session so stale responses cannot reset current UI or event state.

## Server-side additions (small)

1. `GET /sessions/:id/events?since_seq=N` — implemented; returns events with `seq > N`, ordered ascending and bounded by the requested page limit.
2. `GET /events/recent?pool=&tag=&limit=` (optional, nice-to-have) — N most-recent events across all matching sessions, ordered by `ts DESC`. Used for the "all activity" header banner.

Nothing else.

## State model (client)

```ts
type ViewMode = "single" | "swimlane";

interface ClientState {
  view: ViewMode;
  pool: string;
  tag: string;
  search: string;
  typeFilter: Set<ObsEventType>;
  autoScroll: boolean;
  autoAddLanes: boolean;
  sessions: SessionSummary[]; // from /sessions, polled 3s
  selectedSessionIds: Set<string>; // lanes (swimlane) or focus (single)
  lanes: Map<string, LaneState>; // keyed by session_id
  sseStatus: "connecting" | "live" | "disconnected";
}

interface LaneState {
  session: SessionSummary;
  events: ObsEvent[]; // ordered by seq ascending
  lastSeq: number; // for resync
  pausedAutoScroll: boolean;
}
```

## SSE routing rule (swimlane mode)

```
On SSE 'event':
  evt = JSON.parse(data)
  if !state.lanes.has(evt.session_id):
     if !state.autoAddLanes: return
     state.lanes.set(evt.session_id, { session: ?, events: [], lastSeq: -1, pausedAutoScroll: false })
     trigger /sessions refresh to fill in `session`
  lane = state.lanes.get(evt.session_id)
  if evt.seq <= lane.lastSeq: return   // dedupe
  lane.events.push(evt)
  lane.lastSeq = evt.seq
  renderLane(evt.session_id)
```

## Layout sketch (swimlane mode)

```
┌─────────────────────────────────────────────────────────────────────┐
│ pi observability       [Single][Swimlane*]              ● live      │
├──────────────────────────┬──────────────────────────────────────────┤
│ pool: [integration ▼]    │  ┌─planner──┬─reviewer──┬─tester──┐      │
│ tag:  [exp-1 _________]  │  │ ● live   │ ● live    │ ● idle  │      │
│ ☐ auto-add lanes         │  │ gpt-4    │ sonnet-4  │ flash3  │      │
│                          │  ├──────────┼───────────┼─────────┤      │
│ sessions (live)          │  │ user     │ user      │ user    │      │
│ ☑ planner ●              │  │ thinking │ tool_call │ asst    │      │
│ ☑ reviewer ●             │  │ asst     │ tool_res  │ tool    │      │
│ ☑ tester ●               │  │ tool_call│ asst      │ tool_res│      │
│ ☐ helper ●               │  │ tool_res │ turn_end  │ asst    │      │
│ ☐ planner-2              │  │ asst     │ user      │ turn_end│      │
│ …                        │  │ ↓ live   │ ↓ live    │ ↓ idle  │      │
└──────────────────────────┴──────────────────────────────────────────┘
```

## Validation (end-to-end)

1. **Multi-agent harness** (`scripts/spawn-fleet.sh`) — spawns 3 short-running pi sessions concurrently against the live server. Different `--o-name`, same `--o-pool`, same `--o-tag`. Each session does 2-3 tool calls so events interleave.
2. **Headless screenshot** — Playwright loads `http://127.0.0.1:43190/?token=devtoken#swimlane`, selects all 3 sessions, waits for stream, snapshots PNG.
3. **DOM assertions** — count `.lane-column` elements, count `.evt-row` per lane, confirm at least one `tool_call` and one `tool_result` per lane.
4. **Interleave proof** — bash check: parse session_ids from `/sessions/:id/events` and confirm events from different sessions are interleaved in `/events/stream` by inspecting their `ts` field.

## Owners

| Block                                                  | Owner                                            |
| ------------------------------------------------------ | ------------------------------------------------ |
| Single-mode UI upgrades + Swimlane UI                  | **obv-ds** (owns `public/index.html` + `app.js`) |
| Server `since_seq` query param                         | **obv-ds**                                       |
| Multi-agent fleet driver + DOM-level validation script | **obv-flash**                                    |
| Spec, integration, headless screenshot, sign-off       | **obv-claude** (me)                              |

## Done criteria

- Single-mode keyboard nav + filter chips + search work; no regressions on v1 events.
- Swimlane mode shows ≥ 3 distinct columns populated live from a single SSE stream.
- Playwright screenshot saved at `artifacts/swimlane.png`.
- `scripts/smoke-server.sh` still green.
- New `scripts/spawn-fleet.sh` + `scripts/validate-swimlane.ts` both green.
