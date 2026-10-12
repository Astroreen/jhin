/* Jhin web client runtime chunk — sse.js (T300): module 8 of the former
 * single-file runtime (stream frames + prop applier + focus restore), split
 * verbatim at the module markers. Cross-chunk calls run through the shared
 * Jhin namespace (window.Jhin) exactly as they ran inside the single file. */
(() => {
  "use strict";

  const Jhin = window.Jhin || (window.Jhin = {});

  /* Imports from the previously loaded chunks (core.js, actions.js). */
  const { readToken, jhinFetch, seedState } = Jhin;
  const { runDirectiveList, nodeById, applyPatch, swapInner, swapOuter } = Jhin;
  /* module 8: sse */

  /* Frame transport (sdui.md sec. 5): fetch-stream primary (the bearer
     filter guards /ui/stream/*); EventSource only without a token; our
     reconnect, backoff 0.5s..30s; replay from frame ids, idempotent. */

  const ANCHOR_PX = 24;
  const streams = new Map();
  let overviewStream = null;

  function streamPathOf(topic) {
    return topic.split("?")[0];
  }

  function applyFrame(frame, st) {
    if (!frame || typeof frame !== "object") { return; }
    const view = st.view;
    const item = frame.node || frame.patch || frame.replace;
    const id = typeof frame.remove === "string" ? frame.remove
      : (item && typeof item.id === "string" ? item.id : null);
    if (id !== null) {
      st.lastId = id;
      const match = /^(?:ev|msg)-(\d+)/.exec(id);
      if (match && Number(match[1]) > st.lastSeq) {
        st.lastSeq = Number(match[1]);
      }
    }
    if (Array.isArray(frame.client)) {
      runDirectiveList(frame.client);
      return;
    }
    const follow = view && view.getAttribute("data-jhin-auto-scroll") === "true"
      && view.scrollHeight - view.scrollTop - view.clientHeight <= ANCHOR_PX;
    if (typeof frame.remove === "string") {
      st.dead.add(frame.remove);
      const gone = nodeById(frame.remove);
      if (gone) { gone.remove(); }
      if (follow) { view.scrollTop = view.scrollHeight; }
      return;
    }
    if (!item || typeof item.html !== "string") {
      console.warn("jhin: ignoring unknown frame:", frame);
      return;
    }
    if (frame.patch) {
      applyPatch(item.id, item.html);
      return;
    }
    if (frame.node) {
      if (id !== null && st.dead.has(id)) { return; }
      const existing = id === null ? null : nodeById(id);
      if (view && view.getAttribute("data-jhin-mode") === "replace") {
        swapInner(view, item.html);
      } else if (existing) {
        swapOuter(existing, item.html);
      } else if (view) {
        view.insertAdjacentHTML("beforeend", item.html);
      } else {
        console.warn("jhin: node frame without a stream view:", id);
        return;
      }
    } else {
      const target = nodeById(id);
      if (!target) {
        console.warn("jhin: frame target not found:", id);
        return;
      }
      swapOuter(target, item.html);
      seedState();
    }
    if (follow) { view.scrollTop = view.scrollHeight; }
  }

  function streamUrl(st) {
    return st.lastSeq > 0 ? st.path + "?fromSeq=" + st.lastSeq : st.topic;
  }

  function openStream(topic, view) {
    const st = {
      topic: topic, path: streamPathOf(topic), view: view,
      dead: new Set(), lastId: null, lastSeq: 0,
      wait: 500, timer: null, cancel: null, closed: false
    };
    connect(st);
    return st;
  }

  function closeStream(st) {
    st.closed = true;
    clearTimeout(st.timer);
    if (st.cancel) { st.cancel(); st.cancel = null; }
  }

  function scheduleReconnect(st) {
    if (st.closed) { return; }
    const delay = st.wait;
    st.wait = Math.min(st.wait * 2, 30000);
    st.timer = setTimeout(() => connect(st), delay);
  }

  function connect(st) {
    if (st.closed) { return; }
    if (st.view && !st.view.isConnected) {
      closeStream(st);
      streams.delete(st.path);
      return;
    }
    if (readToken() || typeof EventSource === "undefined") {
      fetchLoop(st);
    } else {
      esLoop(st);
    }
  }

  async function fetchLoop(st) {
    const controller = new AbortController();
    st.cancel = () => controller.abort();
    try {
      const headers = { Accept: "text/event-stream" };
      if (st.lastId) { headers["Last-Event-ID"] = st.lastId; }
      const res = await jhinFetch(streamUrl(st), {
        headers: headers,
        signal: controller.signal
      });
      if (!res.ok || !res.body) { throw new Error("stream status " + res.status); }
      st.wait = 500;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const step = await reader.read();
        if (step.done) { break; }
        buffer += decoder.decode(step.value, { stream: true });
        let cut = buffer.indexOf("\n\n");
        while (cut >= 0) {
          onSseBlock(st, buffer.slice(0, cut));
          buffer = buffer.slice(cut + 2);
          cut = buffer.indexOf("\n\n");
        }
      }
    } catch (failure) {
      if (st.closed || controller.signal.aborted) { return; }
      console.warn("jhin: stream reconnecting:", st.path, failure);
    }
    if (!st.closed) { scheduleReconnect(st); }
  }

  function onFrameData(st, raw) {
    try {
      applyFrame(JSON.parse(raw), st);
    } catch (failure) {
      console.warn("jhin: ignoring undecodable frame:", failure);
    }
  }

  function onSseBlock(st, block) {
    let data = "";
    block.split("\n").forEach((line) => {
      if (line.startsWith("data:")) {
        data += (data ? "\n" : "") + line.slice(5).replace(/^ /, "");
      }
    });
    if (data) { onFrameData(st, data); }
  }

  function esLoop(st) {
    let es;
    try {
      es = new EventSource(streamUrl(st));
    } catch {
      scheduleReconnect(st);
      return;
    }
    st.cancel = () => es.close();
    const onEvent = (event) => onFrameData(st, event.data);
    es.addEventListener("frame", onEvent);
    es.addEventListener("message", onEvent);
    es.onopen = () => { st.wait = 500; };
    es.onerror = () => {
      es.close();
      if (!st.closed) { scheduleReconnect(st); }
    };
  }

  function syncStreams() {
    const seen = new Set();
    document.querySelectorAll("[data-jhin-type='stream_view'][data-jhin-topic]")
      .forEach((view) => {
        const topic = view.getAttribute("data-jhin-topic");
        if (!topic) { return; }
        const path = streamPathOf(topic);
        seen.add(path);
        const live = streams.get(path);
        if (live) {
          live.view = view;
        } else {
          streams.set(path, openStream(topic, view));
        }
      });
    streams.forEach((st, path) => {
      if (!seen.has(path)) {
        closeStream(st);
        streams.delete(path);
      }
    });
  }

  function openOverview() {
    if (overviewStream === null) {
      overviewStream = openStream("/ui/stream/sessions-overview", null);
    }
  }

  /* The shared namespace: functions and consts by value; the one mutable
   * binding other chunks read (overviewStream) is published as a live
   * accessor so writes below stay visible across chunks. */
  Object.assign(Jhin, {
    streamPathOf, applyFrame, streamUrl, openStream, closeStream,
    scheduleReconnect, connect, onFrameData, onSseBlock, esLoop,
    syncStreams, openOverview
  });
  Object.defineProperty(Jhin, "overviewStream", {
    get() { return overviewStream; },
    set(value) { overviewStream = value; },
    configurable: true
  });
})();
