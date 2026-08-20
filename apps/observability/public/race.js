/**
 * race.js — Pi Observability Race mode.
 * Horizontal per-agent tracks grouped by concrete turn_start → turn_end chunks.
 * IIFE-wrapped. Uses window.OBS helpers from app.js.
 */
(function () {
  const STATE = window.__OBS_STATE;
  const O = window.OBS;
  const {
    summaryFor,
    eventTypeClass,
    applySummaryClasses,
    renderDetailHTML,
    fmtTs,
    trunc,
    shortId,
    fetchSessionEvents,
    renderSessions,
    apiUrl,
    authHeaders,
    fmtRel,
    fmtTokens,
    saveURLState,
    toolNamePillElement,
  } = O;

  const TRACKS = new Map();
  let autoAddRaceTracks = true;
  let raceSSEResynced = false;
  let openEventId = null;

  const raceContainer = document.getElementById("race-container");
  const raceEmpty = document.getElementById("race-empty");
  const inspector = document.getElementById("race-inspector");
  const inspectorTitle = document.getElementById("race-inspector-title");
  const inspectorBody = document.getElementById("race-inspector-body");
  const inspectorClose = document.getElementById("race-inspector-close");
  const inspectorCopy = document.getElementById("race-inspector-copy");
  const inspectorWrap = document.getElementById("race-inspector-wrap");
  const raceRollup = document.getElementById("race-rollup");
  let stickToRight = true;
  let currentInspectorEvent = null;

  if (raceContainer) {
    raceContainer.addEventListener("scroll", () => {
      const rightGap =
        raceContainer.scrollWidth - raceContainer.scrollLeft - raceContainer.clientWidth;
      stickToRight = rightGap < 80;
    });
  }
  if (inspectorClose) inspectorClose.addEventListener("click", closeInspector);
  if (inspectorCopy)
    inspectorCopy.addEventListener("click", () => {
      if (!currentInspectorEvent) return;
      navigator.clipboard
        ?.writeText(JSON.stringify(currentInspectorEvent.payload, null, 2))
        .catch(() => {});
    });
  if (inspectorWrap)
    inspectorWrap.addEventListener("click", () => {
      const pre = inspectorBody?.querySelector(".race-inspector-detail pre");
      if (!pre) return;
      pre.style.whiteSpace = pre.style.whiteSpace === "pre-wrap" ? "pre" : "pre-wrap";
      inspectorWrap.textContent = pre.style.whiteSpace === "pre-wrap" ? "→" : "↩";
    });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && inspector?.classList.contains("open")) closeInspector();
  });

  // ─── Hooks called from app.js ────────────────────────────────────────────────

  window.__raceOnView = function () {
    for (const [sid, track] of TRACKS) {
      const sess = STATE.sessions.find((s) => s.session_id === sid);
      if (sess) track.session = sess;
    }
    renderAllTracks();
  };

  window.__raceOnSessions = function () {
    for (const s of STATE.sessions) {
      if (TRACKS.has(s.session_id)) TRACKS.get(s.session_id).session = s;
    }
    renderAllTracks();
    renderSessions();
  };

  window.__raceOnReconnect = function () {
    raceSSEResynced = false;
    resyncAllTracks().then(() => {
      raceSSEResynced = true;
    });
  };

  window.__raceOnEvent = function (evt) {
    routeSSEEvent(evt);
  };

  window.__raceIsSelected = (sid) => TRACKS.has(sid);

  window.__raceToggle = function (sid) {
    if (TRACKS.has(sid)) destroyTrack(sid);
    else {
      createTrack(sid);
      window.__OBS_STATE?.ackd?.add(sid);
    }
    renderSessions();
    renderAllTracks();
    saveURLState();
  };

  window.__raceEnsureLane = function (sid) {
    if (!sid || TRACKS.has(sid)) return;
    createTrack(sid);
    renderSessions();
    renderAllTracks();
    saveURLState();
  };

  window.__raceGetLanes = () => Array.from(TRACKS.keys());
  window.__raceGetAll = () => TRACKS;
  window.__raceGetOpenEventId = () => openEventId;
  window.__raceFilterChange = function () {};
  window.__raceAutoAddChange = function (val) {
    autoAddRaceTracks = val;
  };

  window.__raceStatsUpdate = function (sid, stats) {
    const track = TRACKS.get(sid);
    if (!track) return;
    track.costStr = `$${stats.total_cost.toFixed(4)} · ${fmtTokens(stats.total_tokens)} tk`;
    renderTrack(sid);
  };

  window.__raceCloseInspector = closeInspector;

  // ─── Track lifecycle ────────────────────────────────────────────────────────

  function createTrack(sid) {
    if (TRACKS.has(sid) || !raceContainer) return;
    const sess = STATE.sessions.find((s) => s.session_id === sid);
    const el = document.createElement("div");
    el.className = "race-track";
    el.dataset.sid = sid;
    raceContainer.appendChild(el);

    const stats = STATE.sessionStats[sid];
    const costStr = stats
      ? `$${stats.total_cost.toFixed(4)} · ${fmtTokens(stats.total_tokens)} tk`
      : "";
    TRACKS.set(sid, { session: sess, events: [], lastSeq: -1, el, costStr, activeGroupKey: null });
    updateEmpty();
    loadTrackEvents(sid);
  }

  function destroyTrack(sid) {
    const track = TRACKS.get(sid);
    if (!track) return;
    track.el?.remove?.();
    TRACKS.delete(sid);
    updateRaceRollup();
    updateEmpty();
    if (TRACKS.size === 0) closeInspector();
  }

  function mergeTrackEvents(track, incoming) {
    track.events = [
      ...new Map(
        [...track.events, ...incoming]
          .filter((event) => event?.event_id)
          .map((event) => [event.event_id, event]),
      ).values(),
    ].sort((left, right) => Number(left.seq) - Number(right.seq));
    track.lastSeq = track.events.length ? Number(track.events.at(-1).seq) : -1;
  }

  async function loadTrackEvents(sid) {
    const track = TRACKS.get(sid);
    if (!track) return;
    const events = await fetchSessionEvents(sid);
    if (!TRACKS.has(sid)) return;
    mergeTrackEvents(track, events || []);
    renderTrack(sid);
    maybeRestoreInspector(track);
  }

  async function resyncAllTracks() {
    const ps = [];
    for (const [sid, track] of TRACKS) {
      if (track.lastSeq >= 0) {
        ps.push(
          fetchSessionEvents(sid, track.lastSeq).then((events) => {
            if (!events?.length) return;
            mergeTrackEvents(track, events);
            renderTrack(sid);
            maybeRestoreInspector(track);
          }),
        );
      } else ps.push(loadTrackEvents(sid));
    }
    await Promise.allSettled(ps);
  }

  function routeSSEEvent(evt) {
    if (!TRACKS.has(evt.session_id)) {
      if (autoAddRaceTracks) createTrack(evt.session_id);
      else return;
    }
    const track = TRACKS.get(evt.session_id);
    if (!track || track.events.some((event) => event.event_id === evt.event_id)) return;
    mergeTrackEvents(track, [evt]);
    renderTrack(evt.session_id);
  }

  // ─── Rendering ──────────────────────────────────────────────────────────────

  function renderAllTracks() {
    for (const [sid] of TRACKS) renderTrack(sid);
    updateRaceRollup();
    updateEmpty();
    if (stickToRight) scrollRaceToRight();
  }

  function renderTrack(sid) {
    const track = TRACKS.get(sid);
    if (!track?.el) return;
    const sess = STATE.sessions.find((s) => s.session_id === sid) || track.session;
    if (sess) track.session = sess;
    const name = sess?.agent_name ?? sess?.cwd?.split("/").pop() ?? shortId(sid);
    const groups = buildTurnGroups(track.events);
    const latest = track.events[track.events.length - 1];
    track.el.replaceChildren();

    const agent = document.createElement("div");
    agent.className = "race-agent-card";
    const agentName = document.createElement("div");
    agentName.className = "race-agent-name";
    agentName.title = sid;
    agentName.textContent = name;
    const identity = document.createElement("div");
    identity.className = "race-agent-meta";
    const shortSessionId = document.createElement("code");
    shortSessionId.textContent = shortId(sid);
    identity.appendChild(shortSessionId);
    if (sess?.model) identity.append(` · ${sess.model}`);
    const eventCount = document.createElement("div");
    eventCount.className = "race-agent-meta";
    eventCount.textContent = `${track.events.length} events${latest ? ` · ${fmtRel(latest.ts)}` : ""}`;
    agent.append(agentName, identity, eventCount);
    if (track.costStr) {
      const cost = document.createElement("div");
      cost.className = "race-agent-cost";
      cost.textContent = track.costStr;
      agent.appendChild(cost);
    }

    const turns = document.createElement("div");
    turns.className = "race-turns";
    if (!groups.length) {
      turns.innerHTML = '<div class="race-empty-track">loading events…</div>';
    } else {
      let activeIdx = track.activeGroupKey
        ? groups.findIndex((g) => g.key === track.activeGroupKey)
        : -1;
      if (activeIdx < 0) activeIdx = groups.length - 1;
      track.activeGroupKey = groups[activeIdx]?.key ?? null;
      groups.forEach((group, idx) =>
        turns.appendChild(buildTurnGroup(track, group, idx === activeIdx)),
      );
    }

    track.el.appendChild(agent);
    track.el.appendChild(turns);
    updateRaceRollup();
    if (stickToRight) scrollRaceToRight();
  }

  function buildTurnGroup(track, group, active) {
    const wrap = document.createElement("div");
    wrap.className = "race-turn-group" + (active ? " active" : " collapsed");
    const label = group.setup ? "setup" : `turn ${group.turnIndex ?? group.ordinal}`;
    const prompt = group.prompt
      ? trunc(group.prompt, active ? 92 : 30)
      : `${group.events.length} events`;

    if (!active) {
      wrap.title = `${label} · ${group.events.length} events${prompt ? ` · ${prompt}` : ""}`;
      const collapsed = document.createElement("div");
      collapsed.className = "race-turn-collapsed";
      const collapsedLabel = document.createElement("span");
      collapsedLabel.className = "race-turn-label";
      collapsedLabel.textContent = label;
      const collapsedCount = document.createElement("span");
      collapsedCount.className = "race-turn-collapsed-count";
      collapsedCount.textContent = `${group.events.length} events`;
      const collapsedPrompt = document.createElement("span");
      collapsedPrompt.className = "race-turn-collapsed-prompt";
      collapsedPrompt.textContent = prompt;
      collapsed.append(collapsedLabel, collapsedCount, collapsedPrompt);
      wrap.appendChild(collapsed);
      wrap.addEventListener("click", () => {
        track.activeGroupKey = group.key;
        renderTrack(group.sid);
        saveURLState();
      });
      return wrap;
    }

    const head = document.createElement("div");
    head.className = "race-turn-head";
    const headLabel = document.createElement("span");
    headLabel.className = "race-turn-label";
    headLabel.textContent = label;
    const headPrompt = document.createElement("span");
    headPrompt.className = "race-turn-prompt";
    headPrompt.title = prompt;
    headPrompt.textContent = prompt;
    head.append(headLabel, headPrompt);

    const events = document.createElement("div");
    events.className = "race-events";
    for (const evt of group.events) events.appendChild(buildRaceEvent(track, evt));

    wrap.appendChild(head);
    wrap.appendChild(events);
    return wrap;
  }

  function buildRaceEvent(track, evt) {
    const node = document.createElement("div");
    node.className = "race-event";
    const typeClass = eventTypeClass(evt.type);
    node.classList.add(typeClass);
    node.title = summaryFor(evt);
    const top = document.createElement("div");
    top.className = "race-event-top";
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.classList.add(typeClass);
    pill.textContent =
      typeClass === "custom" && evt.type !== "custom" ? evt.type : evt.type.replace(/_/g, " ");
    top.appendChild(pill);
    const toolPill = toolNamePillElement(evt);
    if (toolPill) top.appendChild(toolPill);
    const summary = document.createElement("div");
    summary.className = "race-event-summary";
    applySummaryClasses(summary, evt);
    summary.textContent = summaryFor(evt);
    const time = document.createElement("div");
    time.className = "race-event-time";
    time.textContent = `${fmtTs(evt.ts)} · #${evt.seq}`;
    node.append(top, summary, time);
    node.addEventListener("click", () => openInspector(track, evt));
    return node;
  }

  function buildTurnGroups(events) {
    const groups = [];
    let current = null;
    let ordinal = 0;

    function makeGroup(evt, setup = false) {
      const g = {
        ordinal: setup ? "setup" : ++ordinal,
        setup,
        turnIndex: evt?.payload?.turn_index ?? null,
        prompt: "",
        sid: evt?.session_id ?? "",
        key: "",
        events: [],
        turnStarted: false,
        closed: false,
      };
      groups.push(g);
      return g;
    }

    for (const evt of [...events].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) {
      if (evt.type === "user_message") {
        if (current && current.events.length && !current.closed && current.turnStarted)
          current.closed = true;
        current = makeGroup(evt);
        current.prompt = evt.payload?.text ?? "user prompt";
        current.events.push(evt);
        continue;
      }

      if (evt.type === "turn_start") {
        if (!current || current.closed || current.turnStarted || current.setup)
          current = makeGroup(evt);
        current.turnStarted = true;
        current.turnIndex = evt.payload?.turn_index ?? current.turnIndex;
        current.events.push(evt);
        continue;
      }

      if (!current) current = makeGroup(evt, true);
      current.events.push(evt);

      if (evt.payload?.turn_index != null && current.turnIndex == null)
        current.turnIndex = evt.payload.turn_index;
      if (evt.type === "turn_end") {
        current.turnIndex = evt.payload?.turn_index ?? current.turnIndex;
        current.closed = true;
      }
    }
    const filtered = groups.filter((g) => g.events.length);
    for (const g of filtered) {
      const firstSeq = g.events[0]?.seq ?? "x";
      const turnPart = g.setup ? "setup" : (g.turnIndex ?? g.ordinal);
      g.key = `${g.events[0]?.session_id ?? g.sid}:turn:${turnPart}:first:${firstSeq}`;
    }
    return filtered;
  }

  // ─── Inspector ──────────────────────────────────────────────────────────────

  function openInspector(track, evt) {
    if (!inspector || !inspectorTitle || !inspectorBody) return;
    openEventId = evt.event_id;
    currentInspectorEvent = evt;
    if (inspectorWrap) inspectorWrap.textContent = "↩";
    const sess = track.session || STATE.sessions.find((s) => s.session_id === evt.session_id);
    const name = sess?.agent_name ?? sess?.cwd?.split("/").pop() ?? shortId(evt.session_id);
    inspectorTitle.textContent =
      eventTypeClass(evt.type) === "custom" && evt.type !== "custom"
        ? evt.type
        : evt.type.replace(/_/g, " ");
    const meta = document.createElement("div");
    meta.className = "race-inspector-meta";
    const appendMeta = (label, value) => {
      const labelElement = document.createElement("span");
      labelElement.textContent = label;
      const valueElement = document.createElement("span");
      valueElement.textContent = String(value);
      meta.append(labelElement, valueElement);
      return valueElement;
    };
    const agent = appendMeta("agent", `${name} · ${shortId(evt.session_id)}`);
    agent.title = evt.session_id;
    appendMeta("time", fmtTs(evt.ts));
    appendMeta("seq", evt.seq);
    const type = appendMeta("type", "");
    const pill = document.createElement("span");
    pill.className = "pill";
    const typeClass = eventTypeClass(evt.type);
    pill.classList.add(typeClass);
    pill.textContent =
      typeClass === "custom" && evt.type !== "custom" ? evt.type : evt.type.replace(/_/g, " ");
    type.appendChild(pill);
    const toolPill = toolNamePillElement(evt);
    if (toolPill) type.appendChild(toolPill);
    const summary = document.createElement("div");
    summary.className = "race-inspector-summary";
    summary.textContent = summaryFor(evt);
    const detail = document.createElement("div");
    detail.className = "race-inspector-detail";
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(evt, null, 2);
    detail.appendChild(pre);
    inspectorBody.replaceChildren(meta, summary, detail);
    inspector.classList.add("open");
    raceContainer?.classList.add("inspecting");
    inspector.setAttribute("aria-hidden", "false");
    saveURLState();
  }

  function maybeRestoreInspector(track) {
    const eid = window.__restoreRaceEventId;
    if (!eid || openEventId) return;
    const evt = track.events.find((e) => e.event_id === eid);
    if (!evt) return;
    window.__restoreRaceEventId = null;
    openInspector(track, evt);
  }

  function closeInspector() {
    if (!inspector) return;
    openEventId = null;
    currentInspectorEvent = null;
    inspector.classList.remove("open");
    raceContainer?.classList.remove("inspecting");
    inspector.setAttribute("aria-hidden", "true");
    saveURLState();
  }

  function updateRaceRollup() {
    if (!raceRollup) return;
    let cost = 0,
      tokens = 0;
    for (const [sid, track] of TRACKS) {
      const stats = STATE.sessionStats[sid];
      if (stats) {
        cost += stats.total_cost ?? 0;
        tokens += stats.total_tokens ?? 0;
        continue;
      }
      for (const evt of track.events) {
        if (evt.type !== "assistant_message") continue;
        const u = evt.payload?.usage;
        if (!u) continue;
        cost += u.cost_total ?? 0;
        tokens += u.total_tokens ?? 0;
      }
    }
    raceRollup.textContent = `$${cost.toFixed(4)} · ${fmtTokens(tokens)} tk`;
  }

  function scrollRaceToRight() {
    if (!raceContainer) return;
    const go = () => {
      raceContainer.scrollLeft = raceContainer.scrollWidth;
    };
    go();
    requestAnimationFrame(go);
  }

  function updateEmpty() {
    if (raceEmpty) raceEmpty.style.display = TRACKS.size ? "none" : "flex";
  }

  // 250ms periodic re-anchor to the right for Race mode (pin unless scrolled left)
  setInterval(() => {
    if (STATE.view === "race" && stickToRight) {
      scrollRaceToRight();
    }
  }, 250);
})();
