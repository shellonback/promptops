/* eslint-disable */
/**
 * promptops_bridge.js — Tauri 2 webview initialization_script.
 *
 * Exposes the `window.promptops` API on top of Tauri commands, so the Angular
 * webapp — which only knows `window.promptops` — talks to the native side.
 *
 * This file is injected as a Tauri `initialization_script`, so it runs BEFORE
 * the page's own JS. It is a self-contained IIFE: no imports, no exports, no
 * bundler. Assumes `withGlobalTauri = true` so `window.__TAURI__` exists.
 *
 * Mapping rules (IPC channel name → Rust #[tauri::command] name):
 *   - command name = IPC channel string with ':' and '-' → '_'
 *       'terminal:open'              -> 'terminal_open'
 *       'provider-account:set-active'-> 'provider_account_set_active'
 *   - invoke() takes a named-args object; Tauri converts camelCase JS keys to
 *     snake_case Rust params automatically.
 *   - onX(callback) listeners: Angular wrappers call them as
 *       api.onX((_event, data) => realCb(data))
 *     i.e. the callback expects TWO args (event, data). Each onX therefore
 *     calls cb(undefined, payload). Returns an unsubscribe function.
 *   - Streaming commands (terminal_open / session_create) take Tauri Channel
 *     args and do NOT emit globally; we fan their Channel messages out to
 *     module-level callback arrays so onTerminalOutput / onSessionOutput /
 *     onSessionStatus behave as push streams.
 */
(function () {
  if (!window.__TAURI__) return;

  // Detached windows (Floor plan, Teams): `subagent_output_channel` and `session_status_subscribe`
  // are SINGLE slots on the Rust side (the last one to register wins). If a detached window took them,
  // the main window would stop receiving sub-agent output and session statuses.
  // Unknown label = main window, as before.
  var WINDOW_LABEL = (((window.__TAURI_INTERNALS__ || {}).metadata || {}).currentWindow || {}).label || 'main';
  var IS_MAIN_WINDOW = WINDOW_LABEL.indexOf('detached-') !== 0;

  var invoke = window.__TAURI__.core.invoke;
  var Channel = window.__TAURI__.core.Channel;
  var listen = window.__TAURI__.event.listen;

  // Capture only compiled source coordinates. Messages, rejection values and
  // console arguments can contain prompts or credentials and are never sent.
  var diagnosticWindow = 0;
  var diagnosticCount = 0;
  function reportDiagnostic(kind, error, filename, line, column) {
    try {
      var now = Date.now();
      if (now - diagnosticWindow >= 60000) { diagnosticWindow = now; diagnosticCount = 0; }
      if (diagnosticCount >= 10) return;
      var location = 'unknown';
      var frames = error instanceof Error && typeof error.stack === 'string'
        ? error.stack.split('\n').slice(1, 20) : [];
      if (filename && line) frames.unshift(filename + ':' + line + ':' + (column || 0));
      for (var i = 0; i < frames.length; i++) {
        var match = frames[i].match(/(?:\/|\\)([A-Za-z0-9_.-]+\.(?:js|ts):\d+(?::\d+)?)(?:\)?\s*)$/);
        if (match) { location = match[1]; break; }
      }
      diagnosticCount++;
      invoke('diagnostics_report', { kind: kind, location: location }).catch(function () {});
    } catch (_) { /* Reporting must never cause another error. */ }
  }
  window.addEventListener('error', function (event) {
    reportDiagnostic('frontend_error', event.error, event.filename, event.lineno, event.colno);
  });
  window.addEventListener('unhandledrejection', function (event) {
    reportDiagnostic('unhandled_rejection', event.reason);
  });
  // Angular's default ErrorHandler writes handled framework errors here.
  var originalConsoleError = console.error;
  console.error = function () {
    for (var i = 0; i < arguments.length; i++) {
      if (arguments[i] instanceof Error) { reportDiagnostic('frontend_error', arguments[i]); break; }
    }
    return originalConsoleError.apply(console, arguments);
  };

  // ── helpers ────────────────────────────────────────────────────────────

  /** Fire-and-forget invoke that swallows errors (for "must exist" methods). */
  function call(cmd, args) {
    try {
      return invoke(cmd, args === undefined ? undefined : args);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /**
   * Build a global-event listener that matches the `onX` contract:
   * the callback is invoked as cb(undefined, payload). Returns an unsubscribe.
   * Rust emits via app.emit(<rawChannelString>, payload) — so we listen on the
   * RAW channel string (e.g. 'session:status'), NOT the snake_case command.
   */
  function on(channel, cb) {
    var unlistenP = listen(channel, function (e) {
      cb(undefined, e && e.payload);
    });
    return function () {
      unlistenP.then(function (un) {
        try { un(); } catch (_) {}
      });
    };
  }

  // ── Terminal streaming (Channel-based) ──────────────────────────────────
  var termCbs = [];
  var termOffsets = {}; // terminalId -> cumulative byte offset
  var termDecoders = {}; // terminalId -> stateful TextDecoder (multi-byte safe)
  var sessDecoders = {}; // sessionId -> stateful TextDecoder
  var saDecoders = {}; // subAgentId -> stateful TextDecoder (subagent:output)

  // Session/sub-agent PTY payloads arrive as base64 (one string for a single
  // atob instead of a JSON array of 128K numbers to parse).
  function b64ToBytes(b64) {
    var bin = atob(b64 || '');
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  // ── Session streaming (Channel-based) ───────────────────────────────────
  var sessOutCbs = [];
  var sessStatusCbs = [];

  // ── SSH streaming (Channel-based, SshEvent tagged with `kind`) ──────────
  var sshOutCbs = [];
  var sshClosedCbs = [];
  var sshErrCbs = [];

  // ── FS watch streaming (Channel-based) ──────────────────────────────────
  var fsWatchCbs = [];

  function makeSshChannel() {
    var ch = new Channel();
    ch.onmessage = function (m) {
      // SshEvent { kind: 'output'|'closed'|'error', sessionId, target, ... }
      if (!m) return;
      var list = m.kind === 'output' ? sshOutCbs
        : (m.kind === 'closed' ? sshClosedCbs
          : (m.kind === 'error' ? sshErrCbs : null));
      if (!list) return;
      for (var i = 0; i < list.length; i++) {
        try { list[i](undefined, m); } catch (_) {}
      }
    };
    return ch;
  }

  function makeFsWatchChannel() {
    var ch = new Channel();
    ch.onmessage = function (m) {
      // WatchEvent { cwd, paths }
      if (!m) return;
      for (var i = 0; i < fsWatchCbs.length; i++) {
        try { fsWatchCbs[i](m); } catch (_) {}
      }
    };
    return ch;
  }

  function pushCb(list, cb) {
    list.push(cb);
    return function () {
      var idx = list.indexOf(cb);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  // ── Drag & drop → path (stand-in for webUtils.getPathForFile) ──────────
  // The wry drag-drop handler is disabled (it also swallowed internal HTML5
  // DnD and file drops onto the DOM): drops reach the webview natively
  // but Files have no path. During the drag we read the native drag
  // pasteboard (drag_drop_paths command, macOS) so getDroppedPath(file) stays
  // synchronous at drop time and resolves by basename. '' if unknown.
  var lastDroppedPaths = [];
  var dragPathsInflight = false;
  function refreshDragPaths(e) {
    var types = e && e.dataTransfer && e.dataTransfer.types;
    if (!types || Array.prototype.indexOf.call(types, 'Files') < 0) return;
    if (dragPathsInflight) return;
    dragPathsInflight = true;
    invoke('drag_drop_paths').then(function (paths) {
      dragPathsInflight = false;
      if (paths && paths.length) lastDroppedPaths = paths;
    }, function () { dragPathsInflight = false; });
  }
  window.addEventListener('dragenter', refreshDragPaths, true);
  window.addEventListener('dragover', refreshDragPaths, true);

  // Without the wry handler, a file dropped outside the drop zones would navigate
  // the webview to the file. We cancel the default ONLY for OS file drags, in
  // the bubble phase (the app's handlers run first); internal HTML5 DnD
  // (sessions→folders, tab reordering) stays intact.
  function cancelOsFileDrag(e) {
    var types = e.dataTransfer && e.dataTransfer.types;
    if (types && Array.prototype.indexOf.call(types, 'Files') >= 0) e.preventDefault();
  }
  window.addEventListener('dragover', cancelOsFileDrag, false);
  window.addEventListener('drop', cancelOsFileDrag, false);

  // Diagnostic probe: confirms in the Rust log that global emits reach
  // the webview (subagent:created is the channel under investigation).
  listen('subagent:created', function (e) {
    var id = e && e.payload && e.payload.subAgent && e.payload.subAgent.id;
    try { invoke('bridge_debug', { message: 'subagent:created received in webview, id=' + id }); } catch (_) {}
  });

  // GC the stateful decoder when the sub-agent dies.
  listen('subagent:destroyed', function (e) {
    var p = e && e.payload;
    if (p && p.subAgentId) delete saDecoders[p.subAgentId];
  });

  function makeTerminalChannel() {
    // The channel is per-terminal and receives raw chunks (ArrayBuffer, no
    // JSON envelope). The id only arrives when terminal_open resolves: early
    // messages are queued and flushed by _bind(id).
    var termId = null;
    var pending = [];
    function deliver(id, m) {
      var bytes = m instanceof ArrayBuffer ? new Uint8Array(m)
        : (m && ArrayBuffer.isView(m)) ? new Uint8Array(m.buffer, m.byteOffset, m.byteLength)
        : new Uint8Array(m || []);
      var dec = termDecoders[id] || (termDecoders[id] = new TextDecoder());
      var text = dec.decode(bytes, { stream: true });
      var off = (termOffsets[id] = (termOffsets[id] || 0) + bytes.length);
      var payload = { terminalId: id, data: text, offset: off };
      for (var i = 0; i < termCbs.length; i++) {
        try { termCbs[i](undefined, payload); } catch (_) {}
      }
    }
    var ch = new Channel();
    ch.onmessage = function (m) {
      if (m == null) return;
      if (termId === null) { pending.push(m); return; }
      deliver(termId, m);
    };
    ch._bind = function (id) {
      termId = id;
      for (var i = 0; i < pending.length; i++) deliver(id, pending[i]);
      pending.length = 0;
    };
    return ch;
  }

  // Replay header (session_buffer / subagent_buffer): u64 LE endOffset,
  // high bit = "VT snapshot of the host screen" (term_state) instead of raw bytes.
  // With the VT snapshot, cols/rows (u16 LE) of the host screen follow: `body` is
  // the offset where the bytes to write start.
  function readReplayHeader(u8) {
    var dv = new DataView(u8.buffer, u8.byteOffset, Math.min(u8.length, 12));
    var hi = dv.getUint32(4, true);
    var vt = (hi & 0x80000000) !== 0 && u8.length >= 12;
    return {
      end: dv.getUint32(0, true) + (hi & 0x7fffffff) * 4294967296,
      vt: vt,
      cols: vt ? dv.getUint16(8, true) : 0,
      rows: vt ? dv.getUint16(10, true) : 0,
      body: vt ? 12 : 8,
    };
  }

  function toBytes(m) {
    return m instanceof ArrayBuffer ? new Uint8Array(m)
      : (m && ArrayBuffer.isView(m)) ? new Uint8Array(m.buffer, m.byteOffset, m.byteLength)
      : new Uint8Array(m || []);
  }

  // Absolute byte offsets let each renderer deduplicate its own replay.
  // A buffer read (including background diagnostics) must not mute other consumers.
  // The offset travels INSIDE the frame (term_host: [u64 LE][data], counted by Rust
  // from the PTY spawn): a reattach after a reload stays aligned with the replay.
  var sessOffsets = {};
  // Sessions with a live channel in THIS JS context. Empty after a webview
  // reload: the first getSessionBuffer reattaches the still-live PTY.
  var sessAttached = {};

  function makeSessionOutputChannel(sessionId) {
    // Per-session channel: raw PTY chunks (ArrayBuffer, no base64 or
    // JSON envelope — same contract as makeTerminalChannel). For
    // createSession the id only arrives on resolve: early messages are
    // queued and flushed by _bind(id).
    var sid = sessionId || null;
    var pending = [];
    var cut = 0;
    function deliver(id, m) {
      var u8 = toBytes(m);
      if (u8.length < 8) return;
      // u64 LE without BigInt (buffers stay well below 2^53 bytes).
      var odv = new DataView(u8.buffer, u8.byteOffset, 8);
      var start = odv.getUint32(0, true) + odv.getUint32(4, true) * 4294967296;
      var bytes = u8.subarray(8);
      // PER-CHANNEL cursor: late frames of a previous PTY (wake) cannot
      // silence those of the new one, which restart from 0.
      var end = start + bytes.length;
      if (end <= cut) return; // already covered by the replay we attached from
      if (start < cut) bytes = bytes.subarray(cut - start);
      cut = end;
      sessOffsets[id] = end;
      var sdec = sessDecoders[id] || (sessDecoders[id] = new TextDecoder());
      var text = sdec.decode(bytes, { stream: true });
      var payload = { sessionId: id, data: text, bytes: bytes, endOffset: end };
      for (var i = 0; i < sessOutCbs.length; i++) {
        try { sessOutCbs[i](undefined, payload); } catch (_) {}
      }
    }
    var ch = new Channel();
    ch.onmessage = function (m) {
      if (m == null) return;
      if (sid === null) { pending.push(m); return; }
      deliver(sid, m);
    };
    ch._bind = function (id, startOffset) {
      sid = id;
      sessAttached[id] = true;
      // New PTY = new offset space and new stream: reset the counter
      // and the stateful decoder (the previous PTY's state is garbage).
      // Child window attaching to an already live PTY: start from the end of the buffer.
      cut = startOffset || 0;
      sessOffsets[id] = cut;
      sessDecoders[id] = new TextDecoder();
      for (var i = 0; i < pending.length; i++) deliver(id, pending[i]);
      pending.length = 0;
    };
    return ch;
  }

  // ── Sub-agent output: global RAW channel ────────────────────────────────
  // Registered right away (and on every webview reload: Rust replaces the
  // previous, now dead, channel). Frame: [1B idLen][id][1B parentLen][parent][chunk].
  var saOutCbs = [];
  var saIdDec = new TextDecoder();
  // Replay↔live dedup as for sessions, but without a local counter: the absolute
  // offset arrives INSIDE the frame (Rust counts it from the PTY spawn), so
  // a webview reload does not misalign it. getSubAgentBuffer stores the
  // snapshot's endOffset and here we drop the bytes already written by the replay.
  // Without it, every pane attach loses the chunks that arrived between snapshot and
  // subscription or writes them twice — and with virtualized panes attaching is
  // no longer a rare event.
  var saReplayCut = {}; // subAgentId -> endOffset of the last replay served
  (function () {
    var ch = new Channel();
    ch.onmessage = function (m) {
      var u8 = toBytes(m);
      if (u8.length < 2) return;
      var idLen = u8[0];
      var pOff = 1 + idLen;
      if (u8.length < pOff + 1) return;
      var pLen = u8[pOff];
      var offOff = pOff + 1 + pLen;
      var start = offOff + 8;
      if (u8.length < start) return;
      var id = saIdDec.decode(u8.subarray(1, pOff));
      var parent = saIdDec.decode(u8.subarray(pOff + 1, offOff));

      // u64 LE without BigInt (buffers stay well below 2^53 bytes).
      var odv = new DataView(u8.buffer, u8.byteOffset + offOff, 8);
      var from = odv.getUint32(0, true) + odv.getUint32(4, true) * 4294967296;
      var chunk = u8.subarray(start);
      var to = from + chunk.length;
      var cut = saReplayCut[id] || 0;
      if (to <= cut) return; // fully covered by the replay just written
      if (from < cut) chunk = chunk.subarray(cut - from); // partial overlap

      var dec = saDecoders[id] || (saDecoders[id] = new TextDecoder());
      var payload = {
        subAgentId: id,
        parentSessionId: parent,
        data: dec.decode(chunk, { stream: true }),
      };
      for (var i = 0; i < saOutCbs.length; i++) {
        try { saOutCbs[i](undefined, payload); } catch (_) {}
      }
    };
    if (IS_MAIN_WINDOW) invoke('subagent_output_channel', { onOutput: ch }).catch(function () {});
    // Session child window: a COPY of the frames (Rust), without taking the channel from the main window.
    else if (WINDOW_LABEL.indexOf('detached-session-') === 0) invoke('subagent_output_watch', { onOutput: ch }).catch(function () {});
  })();

  function makeSessionStatusChannel() {
    var ch = new Channel();
    ch.onmessage = function (m) {
      // SessionStatusChange (camelCase) { sessionId, oldStatus, newStatus }
      if (!m) return;
      var sid = m.sessionId != null ? m.sessionId : m.session_id;
      var status = m.newStatus != null ? m.newStatus
        : (m.new_status != null ? m.new_status : m.status);
      var payload = { sessionId: sid, status: status };
      for (var i = 0; i < sessStatusCbs.length; i++) {
        try { sessStatusCbs[i](undefined, payload); } catch (_) {}
      }
    };
    return ch;
  }

  // ─────────────────────────────────────────────────────────────────────────
  var api = {
    // `platform` is a synchronous string property (darwin / win32 / linux).
    // OS declared by lib.rs (authoritative); the userAgent only as a fallback.
    platform: (function () {
      if (window.__PROMPTOPS_OS__) return window.__PROMPTOPS_OS__;
      var p = ((navigator.platform || '') + ' ' + navigator.userAgent).toLowerCase();
      if (p.indexOf('mac') >= 0) return 'darwin';
      if (p.indexOf('win') >= 0) return 'win32';
      return 'linux';
    })(),
    // Native app version (injected by lib.rs before this script);
    // the webapp prefers it over the compiled APP_VERSION (2.x line).
    appVersion: window.__PROMPTOPS_APP_VERSION__ || null,
    // Where the Session Vault key lives: 'keychain', 'file' or 'development'.
    localStoreKeySource: function () { return call('local_store_key_source'); },
    // ── Terminal ───────────────────────────────────────────────────────
    openTerminal: function (options) {
      var ch = makeTerminalChannel();
      var opts = options || {};
      return invoke('terminal_open', {
        shell: opts.shell,
        cwd: opts.cwd,
        cols: opts.cols,
        rows: opts.rows,
        // Wizard install/verify terminal: inherits the session's shell.
        sessionId: opts.sessionId || undefined,
        onOutput: ch,
      }).then(function (id) {
        ch._bind(id);
        return { ok: true, terminalId: id };
      }).catch(function (e) {
        return { ok: false, error: String(e) };
      });
    },

    closeTerminal: function (terminalId) {
      return invoke('terminal_close', { id: terminalId })
        .then(function () {
          // The terminal is gone: drop its stream decoder and byte offset so
          // they do not accumulate for every terminal opened in the session.
          delete termDecoders[terminalId];
          delete termOffsets[terminalId];
          return { ok: true };
        })
        .catch(function (e) { return { ok: false, error: String(e) }; });
    },

    writeTerminal: function (terminalId, data) {
      return invoke('terminal_input', { id: terminalId, data: data })
        .then(function () { return { ok: true }; })
        .catch(function (e) { return { ok: false, error: String(e) }; });
    },

    resizeTerminal: function (terminalId, cols, rows) {
      return invoke('terminal_resize', { id: terminalId, cols: cols, rows: rows })
        .then(function () { return { ok: true }; })
        .catch(function (e) { return { ok: false, error: String(e) }; });
    },

    onTerminalOutput: function (cb) {
      termCbs.push(cb);
      return function () {
        var i = termCbs.indexOf(cb);
        if (i >= 0) termCbs.splice(i, 1);
      };
    },

    listTerminals: function () {
      return invoke('terminal_list')
        .then(function (ids) {
          return (ids || []).map(function (id) { return { id: id, createdAt: '' }; });
        })
        .catch(function () { return []; });
    },

    // terminal:buffer — backlog replay for re-attach (tab/session switch).
    getTerminalBuffer: function (terminalId) {
      return invoke('terminal_buffer', { id: terminalId })
        .then(function (r) {
          return { ok: true, data: (r && r.data) || '', endOffset: (r && r.endOffset) || 0 };
        })
        .catch(function () { return { ok: true, data: '', endOffset: 0 }; });
    },

    // ── Provider check ──────────────────────────────────────────────────
    // sessionId: a WSL/Git Bash session probes the CLI inside its own shell.
    checkProvider: function (provider, force, sessionId) {
      return call('provider_check', {
        provider: provider,
        force: force === true,
        sessionId: sessionId || undefined,
      });
    },

    // ── Local data (sessions, workspaces, prompts… kept on this device) ──
    // method: e.g. 'sessions.list'; params: plain object. Rejects with
    // { code, message, details? }.
    localCall: function (method, params) {
      return call('local_call', { method: method, params: params === undefined ? null : params });
    },

    // ── Provider capability registry ─────────────────────────────────────
    listProviderCapabilities: function () { return call('providers_list'); },
    detectProviders: function (force) { return call('providers_detect', { force: force === true }); },
    /** Account models read from the CLI (today: agy models). [] = use the static list. */
    listProviderModels: function (provider, force) { return call('providers_models', { provider: provider, force: force === true }); },

    // ── PromptOps CLI config ─────────────────────────────────────────────
    getFccConfig: function () { return call('fcc_config_get'); },
    saveFccConfig: function (config) { return call('fcc_config_save', { config: config }); },
    testFccConnection: function () { return call('fcc_config_test'); },
    getFccCatalog: function () { return call('fcc_config_catalog'); },

    // ── Local hardware scan ──────────────────────────────────────────────
    scanHardwareForModels: function (options) { return call('hardware_scan', { options: options || null }); },

    // ── AI generation (provider CLI) ─────────────────────────────────────
    aiGenerateText: function (prompt, provider, cwd, timeoutMs, model) {
      return call('ai_generate_text', {
        prompt: prompt,
        provider: provider,
        cwd: cwd,
        timeoutMs: typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : null,
        model: model || null,
      });
    },

    // ── Sessions ─────────────────────────────────────────────────────────
    createSession: function (request) {
      var outCh = makeSessionOutputChannel();
      var statCh = makeSessionStatusChannel();
      return invoke('session_create', {
        request: request,
        onOutput: outCh,
        onStatus: statCh,
      }).then(function (res) {
        if (res && res.session && res.session.id) outCh._bind(res.session.id);
        return res;
      });
    },

    destroySession: function (sessionId) { return call('session_destroy', { sessionId: sessionId }); },
    listSessions: function () { return call('session_list'); },
    getSession: function (sessionId) { return call('session_get', { sessionId: sessionId }); },
    writeSession: function (sessionId, data, opts) {
      // countPrompt=false: re-sending an Enter already counted (submit retry).
      var countPrompt = !(opts && opts.countPrompt === false);
      return call('session_write', { sessionId: sessionId, data: data, countPrompt: countPrompt });
    },
    resizeSession: function (sessionId, cols, rows) {
      return call('session_resize', { sessionId: sessionId, cols: cols, rows: rows });
    },
    // Child window: receives a copy of the live output of a PTY already started by the main window.
    // The subscription comes BEFORE the buffer read: chunks in between stay queued, not lost.
    watchSessionOutput: function (sessionId) {
      var ch = makeSessionOutputChannel(null);
      return invoke('session_output_watch', { sessionId: sessionId, onOutput: ch })
        .then(function () { return invoke('session_buffer', { sessionId: sessionId }); })
        .then(function (r) {
          var u8 = toBytes(r);
          var end = 0;
          if (u8.length >= 8) end = readReplayHeader(u8).end;
          ch._bind(sessionId, end);
          return { ok: true };
        })
        .catch(function (e) { return { ok: false, error: String(e) }; });
    },
    getSessionBuffer: function (sessionId) {
      // RAW response (ArrayBuffer): 8-byte u64 LE endOffset + payload.
      // Raw bytes and offset allow per-renderer replay/live reconciliation.
      // Webview reload with a live PTY: reattach the output BEFORE reading the
      // buffer (chunks in between arrive with their offset and the renderer
      // dedupes them). false = no live PTY (parked): everything stays as it was.
      var attach = (IS_MAIN_WINDOW && sessionId && !sessAttached[sessionId])
        ? (function () {
            var ch = makeSessionOutputChannel(sessionId);
            return invoke('session_output_attach', { sessionId: sessionId, onOutput: ch })
              .then(function (ok) { if (ok) ch._bind(sessionId, 0); })
              .catch(function () {});
          })()
        : null;
      var read = function () { return invoke('session_buffer', { sessionId: sessionId }); };
      // No reattach needed: read right away (no extra tick before the request).
      return (attach ? attach.then(read) : read())
        .then(function (r) {
          var u8 = toBytes(r);
          if (u8.length < 8) return { ok: true, data: '' };
          var head = readReplayHeader(u8);
          var bytes = u8.subarray(head.body);
          return {
            ok: true, data: new TextDecoder().decode(bytes), bytes: bytes, endOffset: head.end,
            vtSnapshot: head.vt, cols: head.cols || undefined, rows: head.rows || undefined,
          };
        })
        .catch(function (e) { return { ok: false, data: '', error: String(e) }; });
    },
    renameSession: function (sessionId, name) { return call('session_rename', { sessionId: sessionId, name: name }); },
    updateSessionMeta: function (sessionId, updates) {
      return call('session_update_meta', { sessionId: sessionId, updates: updates });
    },

    // Model actually in use by the terminal (follows a /model inside the TUI).
    // The renderer asks at most every 15s per visible session and falls back to
    // the spawn model when the answer is null.
    getSessionModel: function (sessionId) {
      return call('session_current_model', { sessionId: sessionId })
        .catch(function () { return { model: null, source: null }; });
    },

    onSessionStatus: function (cb) {
      sessStatusCbs.push(cb);
      // Channel registered even without create (restored at boot / webview reload).
      if (IS_MAIN_WINDOW) {
        invoke('session_status_subscribe', { onStatus: makeSessionStatusChannel() })
          .catch(function () {});
      }
      return function () {
        var i = sessStatusCbs.indexOf(cb);
        if (i >= 0) sessStatusCbs.splice(i, 1);
      };
    },
    // ── Agents: the session PTY is the "lead", one agent among
    // others. The webapp feature-detects these
    // functions and stays on the classic flow when they are missing.
    agentsMetaGet: function (sessionId) {
      return call('agents_meta_get', { sessionId: sessionId });
    },
    agentsSetLead: function (sessionId, leadId) {
      return call('agents_set_lead', { sessionId: sessionId, leadId: leadId == null ? null : leadId });
    },
    agentsSetOrder: function (sessionId, order) {
      return call('agents_set_order', { sessionId: sessionId, order: order || [] });
    },
    agentsCloseLead: function (sessionId) {
      return call('agents_close_lead', { sessionId: sessionId });
    },
    // Explicit lead reopen: respawn via wake → needs a new output Channel,
    // bound on resolve like wakeSession.
    agentsReopenLead: function (sessionId, dims) {
      var ch = makeSessionOutputChannel();
      return call('agents_reopen_lead', {
        sessionId: sessionId,
        onOutput: ch,
        cols: dims && dims.cols,
        rows: dims && dims.rows,
      }).then(function (res) {
        ch._bind((res && res.id) || sessionId);
        return res;
      });
    },
    onAgentsChanged: function (cb) { return on('agents:changed', cb); },
    agentsClearLeadClosedAll: function () { return call('agents_clear_lead_closed_all'); },
    standbySession: function (sessionId) {
      return call('session_standby', { sessionId: sessionId });
    },
    wakeSession: function (sessionId, parkedSubAgents, dims) {
      // Wake respawns the PTY: a new output Channel is needed. Bind on
      // resolve: for restored sessions the caller passes the dbId, the summary
      // returns the local id (the one the renderer uses to attach).
      var wakeCh = makeSessionOutputChannel();
      return call('session_wake', {
        sessionId: sessionId,
        onOutput: wakeCh,
        // Current xterm dims: the PTY is reborn at the right grid instead
        // of the 120×30 default (undefined = fall back to config cols/rows).
        cols: dims && dims.cols,
        rows: dims && dims.rows,
      }).then(function (res) {
        // No-op wake (already awake, lead closed, session missing): no new
        // PTY, the channel stays unused. Binding it would reset sessOffsets
        // of the live PTY and the replay would drop the live output (shell
        // prompt invisible until the first Enter).
        if (res && res.respawned !== false) wakeCh._bind(res.id || sessionId);
        // The localStorage stash of parked sub-agents travels with the wake
        // as well: the respawn waits for the PTY to be ready on the Rust side.
        if (parkedSubAgents && parkedSubAgents.length) {
          call('subagent_restore_stash', {
            sessionId: sessionId,
            subAgents: parkedSubAgents,
          }).catch(function () {});
        }
        return res;
      });
    },
    onSessionStandbyChanged: function (cb) { return on('session:standby-changed', cb); },
    // Account switch (AI Accounts): is the conversation from another account?
    checkSessionAccount: function (sessionId) { return call('session_account_check', { sessionId: sessionId }); },
    // Parks the session and marks the next wake as a new conversation on the active account.
    prepareSessionAccountRelaunch: function (sessionId) {
      return call('session_prepare_account_relaunch', { sessionId: sessionId });
    },
    // In-place provider switch of the main session (same PTY).
    switchSessionProvider: function (request) { return call('session_switch_provider', { request: request }); },
    getSessionHandoffContext: function (sessionId) { return call('session_handoff_context', { sessionId: sessionId }); },
    onSessionProviderSwitch: function (cb) { return on('session:provider-switch', cb); },
    getAutoStandbyConfig: function () { return call('auto_standby_get_config'); },
    getActiveSessionProfile: function () { return call('session_profile_get_active'); },
    setActiveSessionProfile: function (profileId) {
      return call('session_profile_set_active', { profileId: profileId });
    },
    onSessionProfileChanged: function (cb) { return on('session-profile:changed', cb); },
    onTailerAutoApproveDisabled: function (cb) { return on('tailer:aa-auto-disabled', cb); },
    setAutoStandbyConfig: function (config) {
      return call('auto_standby_set_config', { config: config });
    },

    onSessionOutput: function (cb) {
      sessOutCbs.push(cb);
      return function () {
        var i = sessOutCbs.indexOf(cb);
        if (i >= 0) sessOutCbs.splice(i, 1);
      };
    },

    // ── Interactions ─────────────────────────────────────────────────────
    listInteractions: function (sessionId) { return call('interaction_list', { sessionId: sessionId }); },
    respondToInteraction: function (response) { return call('interaction_respond', { response: response }); },
    onInteractionCreated: function (cb) { return on('interaction:created', cb); },
    onInteractionResolved: function (cb) { return on('interaction:resolved', cb); },

    // ── Auto-approve (per-session flags) ─────────────────────────────────
    getAutoApproveFlags: function (sessionId) { return call('auto_approve_get', { sessionId: sessionId }); },
    setAutoApproveFlags: function (sessionId, flags) {
      return call('auto_approve_set', { sessionId: sessionId, flags: flags });
    },
    onAutoApproveChanged: function (cb) { return on('auto-approve:changed', cb); },

    onTailerResponseReady: function (cb) { return on('tailer:response-ready', cb); },
    tailerInject: function (sessionId, response) {
      return call('tailer_inject', { sessionId: sessionId, response: response });
    },
    onTailerAutoApproved: function (cb) { return on('tailer:auto-approved', cb); },
    onTailerThinking: function (cb) { return on('tailer:thinking', cb); },

    // ── Profiles ─────────────────────────────────────────────────────────
    listProfiles: function () { return call('profile_list'); },
    getProfile: function (profileId) { return call('profile_get', { profileId: profileId }); },
    createProfile: function (data) { return call('profile_create', { data: data }); },
    updateProfile: function (profileId, updates) {
      return call('profile_update', { profileId: profileId, updates: updates });
    },
    deleteProfile: function (profileId) { return call('profile_delete', { profileId: profileId }); },

    // ── Workspace ────────────────────────────────────────────────────────
    selectWorkspace: function () { return call('workspace_select'); },
    getRecentWorkspaces: function () { return call('workspace_recent'); },
    createWorkspaceFolder: function (payload) {
      var p = payload || {};
      return call('workspace_create_folder', {
        parentPath: p.parentPath, folderName: p.folderName,
      });
    },
    checkWorkspaceContextFile: function (payload) {
      var p = payload || {};
      return call('workspace_context_file_check', { path: p.path, provider: p.provider });
    },
    setWorkspaceContextPolicy: function (payload) {
      var p = payload || {};
      return call('workspace_context_policy_set', {
        path: p.path, mode: p.mode, files: p.files,
      });
    },
    collectProjectBrief: function (payload) {
      var p = payload || {};
      return call('project_brief_collect', { workspacePath: p.workspacePath });
    },

    // ── AI Agent Evals (native page) ──
    speedTestListModels: function () { return call('speedtest_list_models'); },
    speedTestRun: function (modelIds, cwd, modeId) { return call('speedtest_run', { modelIds: modelIds, cwd: cwd, modeId: modeId }); },
    speedTestAbort: function () { return call('speedtest_abort'); },
    onSpeedTestProgress: function (cb) { return on('speedtest:progress', cb); },

    // ── Browser (Browser page: real Chrome via CDP screencast) ─────────
    browserChromeStatus: function (port) { return invoke('browser_chrome_status', { port: port }); },
    browserChromeLaunch: function (url, port) { return invoke('browser_chrome_launch', { url: url, port: port }); },
    browserChromeOpenTab: function (url, port) { return invoke('browser_chrome_open_tab', { url: url, port: port }); },
    browserChromeCloseTab: function (targetId, port) { return invoke('browser_chrome_close_tab', { targetId: targetId, port: port }); },
    browserChromeActivateTab: function (targetId, port) { return invoke('browser_chrome_activate_tab', { targetId: targetId, port: port }); },
    // MirrorEvent events (kind: frame|nav|result|closed) on the callback; returns the mirror id.
    browserMirrorStart: function (opts, cb) {
      var ch = new Channel();
      ch.onmessage = function (ev) { try { cb(ev); } catch (_) {} };
      var o = opts || {};
      return invoke('browser_mirror_start', {
        wsUrl: o.wsUrl, maxWidth: o.maxWidth, maxHeight: o.maxHeight, quality: o.quality, onEvent: ch,
      });
    },
    browserMirrorSend: function (id, method, params) { return invoke('browser_mirror_send', { id: id, method: method, params: params || {} }); },
    browserMirrorStop: function (id) { return invoke('browser_mirror_stop', { id: id }); },
    browserIntegrationProbe: function (provider) { return invoke('browser_integration_probe', { provider: provider }); },
    browserProfileImportExtension: function (sourceDir, extensionId, port) { return invoke('browser_profile_import_extension', { sourceDir: sourceDir, extensionId: extensionId, port: port }); },
    browserTerminalCwd: function (provider) { return invoke('browser_terminal_cwd', { provider: provider }); },
    // "My Chrome" mode: captures the regular Chrome window (macOS).
    browserWindowMirrorStart: function (opts, cb) {
      var ch = new Channel();
      ch.onmessage = function (ev) { try { cb(ev); } catch (_) {} };
      return invoke('browser_window_mirror_start', { fps: (opts && opts.fps) || undefined, onEvent: ch });
    },
    browserWindowMirrorStop: function (id) { return invoke('browser_window_mirror_stop', { id: id }); },
    browserChromeFocus: function () { return invoke('browser_chrome_focus'); },

    devLinksScan: function (cwd, force) {
      return call('dev_links_scan', { cwd: cwd, force: force });
    },
    devLinksOpen: function (url) { return call('dev_links_open', { url: url }); },
    devLinksDefaultBrowser: function () { return call('dev_links_default_browser'); },
    portsList: function (cwd) { return call('ports_list', { cwd: cwd || null }); },
    portsForward: function (opts) {
      return call('ports_forward', { targetPort: opts.targetPort, targetHost: opts.targetHost || null, localPort: opts.localPort == null ? null : opts.localPort, public: !!opts.public });
    },
    portsStop: function (localPort) { return call('ports_stop', { localPort: localPort }); },

    // ── Folder access (TCC macOS) ────────────────────────────────────────
    checkFolderAccess: function () { return call('folder_access_check'); },
    retryFolderAccess: function () { return call('folder_access_retry'); },
    openFolderAccessSettings: function () { return call('folder_access_open_settings'); },
    onFolderAccessChanged: function (cb) { return on('folder-access:changed', cb); },
    resetFolderAccessPermissions: function () {
      return call('folder_access_reset_permissions');
    },
    relaunchAppForFolderAccess: function () { return call('folder_access_relaunch'); },

    // ── Windows shells + per-workspace account + terminal flags ─────────
    listTerminalShells: function (opts) {
      var o = opts || {};
      return call('terminal_shells_list', { force: o.force });
    },
    probeProviderInShells: function (provider) {
      return call('terminal_shells_probe_provider', { provider: provider });
    },
    // Settings default (native fallback for sessions without an override).
    setDefaultTerminalShell: function (shell) {
      return call('terminal_shells_set_default', { shell: shell || null });
    },
    applyAccountToWorkspace: function (args) {
      var a = args || {};
      return call('session_apply_account_to_workspace', {
        workspaceId: a.workspaceId,
        provider: a.provider,
        providerAccountId: a.providerAccountId,
        inherit: a.inherit,
      });
    },
    setTerminalDetection: function (flags) {
      var f = flags || {};
      return call('app_set_terminal_detection', {
        commandDetection: f.commandDetection,
        inputDetection: f.inputDetection,
        activityTail: f.activityTail,
      });
    },
    setTerminalSafeMode: function (enabled) {
      return call('app_set_terminal_safe_mode', { enabled: enabled });
    },
    // Terminal replay from the screen snapshot kept by Rust (term_state).
    setTerminalHostScreen: function (enabled) {
      return call('term_vt_replay_set', { enabled: !!enabled });
    },
    // Agents in the external termd host (they survive crashes and updates).
    setTerminalPersistentAgents: function (enabled) {
      return call('termd_set_enabled', { enabled: !!enabled });
    },
    getDroppedPath: function (file) {
      if (!file || !file.name) return '';
      for (var i = 0; i < lastDroppedPaths.length; i++) {
        var p = lastDroppedPaths[i];
        var base = p.split(/[\\/]/).pop();
        if (base === file.name) return p;
      }
      return '';
    },

    // ── Presence signals ─────────────────────────────────────────────────
    onPresenceSystemAway: function (cb) { return on('presence:system-away', cb); },
    onPresenceSystemActive: function (cb) { return on('presence:system-active', cb); },

    // ── Voice ────────────────────────────────────────────────────────────
    debugLog: function (message) { return call('bridge_debug', { message: message }); },
    // NB: the Rust command takes a NAMED `opts` parameter — passing
    // the flattened object made it arrive as None (same class of bug
    // as provider_account): Rust ignored the webapp's audio and
    // re-recorded 2s with sox AFTER the speech → it transcribed silence.
    transcribeVoice: function (opts) { return call('voice_transcribe', { opts: opts }); },
    checkMicPermission: function () { return call('voice_check_mic'); },
    openMicSettings: function () { return call('voice_open_mic_settings'); },
    getVoiceApiKey: function () { return call('voice_get_api_key'); },
    setVoiceApiKey: function (apiKey) { return call('voice_set_api_key', { apiKey: apiKey }); },
    testVoiceApiKey: function (apiKey) { return call('voice_test_api_key', { apiKey: apiKey }); },
    voiceLocalModelStatus: function () { return call('voice_local_model_status'); },
    voiceLocalModelDownload: function () { return call('voice_local_model_download'); },
    onVoiceLocalModel: function (cb) { return on('voice:local-model', cb); },

    // ── Voice global shortcut (push-to-talk hold) ────────────────────────
    onVoiceHotkeyToggle: function (cb) {
      // wrapper invokes callback() with no args
      return on('voice:hotkey-toggle', function () { cb(); });
    },
    onVoiceHotkeyCancel: function (cb) {
      return on('voice:hotkey-cancel', function () { cb(); });
    },
    getVoiceShortcutConfig: function () { return call('voice_get_shortcut_config'); },
    setVoiceShortcutConfig: function (patch) { return call('voice_set_shortcut_config', patch); },
    openVoiceSystemSettings: function (pane) { return call('voice_open_system_settings', { pane: pane }); },

    // ── Focus tracker ────────────────────────────────────────────────────
    getActiveFocus: function () { return call('focus_get_active'); },
    setActiveFocus: function (patch) { return call('focus_set_active', { patch: patch || null }); },
    onActiveFocusChanged: function (cb) {
      // The wrapper passes a single arg: callback(state)
      return on('focus:active-changed', function (_e, state) { cb(state); });
    },

    // ── Git ──────────────────────────────────────────────────────────────
    getGitStatus: function (cwd) { return call('git_status', { cwd: cwd }); },
    gitStage: function (cwd, paths) { return call('git_stage', { cwd: cwd, paths: paths }); },
    gitUnstage: function (cwd, paths) { return call('git_unstage', { cwd: cwd, paths: paths }); },
    gitCommit: function (cwd, message) { return call('git_commit', { cwd: cwd, message: message }); },
    gitDiff: function (cwd, staged) { return call('git_diff', { cwd: cwd, staged: staged }); },
    gitCommitWithPaths: function (cwd, message, paths) {
      return call('git_commit', { cwd: cwd, message: message, paths: paths });
    },
    gitStash: function (cwd) { return call('git_stash', { cwd: cwd }); },
    gitStashPop: function (cwd) { return call('git_stash_pop', { cwd: cwd }); },
    gitPull: function (cwd) { return call('git_pull', { cwd: cwd }); },
    gitPush: function (cwd) { return call('git_push', { cwd: cwd }); },
    gitExec: function (cwd, command) { return call('git_exec', { cwd: cwd, command: command }); },
    gitListBranches: function (cwd) { return call('git_list_branches', { cwd: cwd }); },
    gitCheckout: function (cwd, branch) { return call('git_checkout', { cwd: cwd, branch: branch }); },
    gitCreateBranch: function (cwd, branch, startPoint) {
      return call('git_create_branch', { cwd: cwd, branch: branch, startPoint: startPoint || null });
    },
    gitGenerateCommitMsg: function (cwd, provider, options) {
      return call('git_generate_commit_msg', { cwd: cwd, provider: provider, options: options || null });
    },
    gitGenerateBranchName: function (cwd, provider, options) {
      return call('git_generate_branch_name', { cwd: cwd, provider: provider, options: options || null });
    },
    gitFileDiff: function (cwd, filePath) { return call('git_file_diff', { cwd: cwd, filePath: filePath }); },
    gitFileAtHead: function (cwd, filePath) { return call('git_file_at_head', { cwd: cwd, filePath: filePath }); },
    gitLog: function (cwd, limit) { return call('git_log', { cwd: cwd, limit: limit }); },
    gitShow: function (cwd, hash) { return call('git_show', { cwd: cwd, hash: hash }); },
    gitCommitFiles: function (cwd, hash) { return call('git_commit_files', { cwd: cwd, hash: hash }); },
    gitCommitFileDiff: function (cwd, hash, filePath) { return call('git_commit_file_diff', { cwd: cwd, hash: hash, filePath: filePath }); },
    gitConflictFiles: function (cwd) { return call('git_conflict_files', { cwd: cwd }); },
    gitResolveConflict: function (cwd, filePath, provider) {
      return call('git_resolve_conflict', { cwd: cwd, filePath: filePath, provider: provider });
    },
    gitClone: function (url, destination, branch) {
      return call('git_clone', { url: url, destination: destination, branch: branch });
    },
    gitDiscoverRepos: function (cwd) { return call('git_discover_repos', { cwd: cwd }); },
    gitMerge: function (cwd, sources, target, strategy, message, autoStash) {
      return call('git_merge', {
        cwd: cwd, sources: sources, target: target,
        strategy: strategy, message: message, autoStash: autoStash,
      });
    },
    gitMergeAbort: function (cwd) { return call('git_merge_abort', { cwd: cwd }); },
    gitCherryPick: function (cwd, hash) { return call('git_cherry_pick', { cwd: cwd, hash: hash }); },
    gitRevert: function (cwd, hash) { return call('git_revert', { cwd: cwd, hash: hash }); },
    gitRebase: function (cwd, onto) { return call('git_rebase', { cwd: cwd, onto: onto }); },
    gitReset: function (cwd, hash, mode) {
      return call('git_reset', { cwd: cwd, hash: hash, mode: mode });
    },
    gitDeleteBranch: function (cwd, branch, opts) {
      var o = opts || {};
      return call('git_delete_branch', {
        cwd: cwd, branch: branch, force: o.force, remote: o.remote,
      });
    },
    gitRenameBranch: function (cwd, branch, newName) {
      return call('git_rename_branch', { cwd: cwd, branch: branch, newName: newName });
    },
    gitCommitAmend: function (cwd, message, allowPushed) {
      return call('git_commit_amend', { cwd: cwd, message: message, allowPushed: allowPushed });
    },
    gitFetch: function (cwd) { return call('git_fetch', { cwd: cwd }); },
    gitAheadBehind: function (cwd) { return call('git_ahead_behind', { cwd: cwd }); },
    gitTag: function (cwd, name, hash, message) {
      return call('git_tag', { cwd: cwd, name: name, hash: hash, message: message });
    },
    gitRemoteUrl: function (cwd) { return call('git_remote_url', { cwd: cwd }); },
    gitShowFileBase64: function (cwd, rev, filePath) {
      return call('git_show_file_base64', { cwd: cwd, rev: rev, filePath: filePath });
    },
    gitAiResolveSync: function (cwd, operation, provider, lastError, opts) {
      return call('git_ai_resolve_sync', {
        cwd: cwd, operation: operation, provider: provider, lastError: lastError,
        auto: !!(opts && opts.auto),
      });
    },

    // ── Git Setup Assistant ──────────────────────────────────────────────
    gitSetupDiagnose: function (cwd, lastError) {
      return call('git_setup_diagnose', { cwd: cwd, lastError: lastError });
    },
    gitSetupListKeys: function () { return call('git_setup_list_keys'); },
    gitSetupGenerateKey: function (opts) { return call('git_setup_generate_key', opts); },
    gitSetupSaveKey: function (opts) { return call('git_setup_save_key', opts); },
    gitSetupStartAgent: function () { return call('git_setup_start_agent'); },
    gitSetupAddKey: function (keyPath, passphrase) {
      return call('git_setup_add_key', { keyPath: keyPath, passphrase: passphrase });
    },
    gitSetupListAgentKeys: function () { return call('git_setup_list_agent_keys'); },
    gitSetupSetIdentity: function (cwd, name, email, global) {
      return call('git_setup_set_identity', { cwd: cwd, name: name, email: email, global: global });
    },
    gitSetupConvertRemote: function (cwd, remoteName) {
      return call('git_setup_convert_remote', { cwd: cwd, remoteName: remoteName });
    },
    gitSetupTestConnection: function (host) { return call('git_setup_test_connection', { host: host }); },
    gitSetupSetPref: function (cwd, selectedKeyPath) {
      return call('git_setup_set_pref', { cwd: cwd, selectedKeyPath: selectedKeyPath });
    },

    // ── Database Explorer ────────────────────────────────────────────────
    dbDetect: function (cwd, provider, forceRefresh) {
      return call('db_detect', { cwd: cwd, provider: provider, forceRefresh: forceRefresh });
    },
    dbConnect: function (cwd) { return call('db_connect', { cwd: cwd }); },
    dbTables: function (cwd) { return call('db_tables', { cwd: cwd }); },
    dbQuery: function (cwd, table, opts) {
      var payload = { cwd: cwd, table: table };
      if (opts) for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) payload[k] = opts[k];
      return call('db_query', payload);
    },
    // NL → read-only query via AI (sessionKey ignored: connections
    // are keyed by cwd). It used to be missing: the DB Explorer called a
    // nonexistent API and the feature did nothing.
    dbNlQuery: function (cwd, question, provider) {
      return call('db_nl_query', { cwd: cwd, question: question, provider: provider });
    },
    dbDisconnect: function (cwd) { return call('db_disconnect', { cwd: cwd }); },
    dbManualConnect: function (cwd, config, name, id) {
      return call('db_manual_connect', { cwd: cwd, config: config, name: name, id: id });
    },
    dbListConfigs: function (cwd) { return call('db_list_configs', { cwd: cwd }); },
    dbSwitchConfig: function (cwd, id) { return call('db_switch_config', { cwd: cwd, id: id }); },
    dbDeleteConfig: function (cwd, id) { return call('db_delete_config', { cwd: cwd, id: id }); },

    // ── Docker ───────────────────────────────────────────────────────────
    dockerPs: function (cwd) { return call('docker_ps', { cwd: cwd }); },

    // ── Sub-Agents ───────────────────────────────────────────────────────
    getSubAgentSuggestions: function (sessionId, workspacePath) {
      return call('subagent_get_suggestions', { sessionId: sessionId, workspacePath: workspacePath })
        .then(function (list) { return { ok: true, suggestions: list || [] }; })
        .catch(function (e) { return { ok: false, error: String(e) }; });
    },
    // Rust signature: (request, on_output: Channel). Output arrives on the global
    // RAW channel (subagent_output_channel) → the per-spawn Channel is ignored.
    spawnSubAgent: function (request) {
      return invoke('subagent_spawn', { request: request, onOutput: new Channel() });
    },
    destroySubAgent: function (subAgentId) {
      return call('subagent_destroy', { subAgentId: subAgentId })
        .then(function () { return { ok: true }; })
        .catch(function (e) { return { ok: false, error: String(e) }; });
    },
    // Envelope {ok, subAgents} — Rust returns the bare array.
    listSubAgents: function (parentSessionId) {
      return call('subagent_list', { parentSessionId: parentSessionId })
        .then(function (list) { return { ok: true, subAgents: list || [] }; })
        .catch(function (e) { return { ok: false, error: String(e) }; });
    },
    // All sub-agents in one IPC,
    // for the boot sweep. The webapp feature-detects this function.
    listAllSubAgents: function () {
      return call('subagent_list_all')
        .then(function (list) { return { ok: true, subAgents: list || [] }; })
        .catch(function (e) { return { ok: false, error: String(e) }; });
    },
    writeSubAgent: function (subAgentId, data) { return call('subagent_write', { subAgentId: subAgentId, data: data }); },
    // In-place provider switch (same PTY): exits the TUI, relaunches, injects.
    switchSubAgentProvider: function (request) {
      return call('subagent_switch_provider', { request: request })
        .then(function (subAgent) { return { ok: true, subAgent: subAgent }; })
        .catch(function (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; });
    },
    // RAW response (ArrayBuffer): 8-byte u64 LE endOffset + payload, like
    // getSessionBuffer. The endOffset arms the live channel dedup
    // (saReplayCut); the contract toward the webapp stays { ok, data }.
    getSubAgentBuffer: function (subAgentId) {
      return invoke('subagent_buffer', { subAgentId: subAgentId })
        .then(function (r) {
          var u8 = toBytes(r);
          if (u8.length < 8) return { ok: true, data: '' };
          var head = readReplayHeader(u8);
          if (head.end > 0) saReplayCut[subAgentId] = head.end;
          return {
            ok: true, data: new TextDecoder().decode(u8.subarray(head.body)),
            vtSnapshot: head.vt, cols: head.cols || undefined, rows: head.rows || undefined,
          };
        })
        .catch(function (e) { return { ok: false, data: '', error: String(e) }; });
    },
    resizeSubAgent: function (subAgentId, cols, rows) {
      return call('subagent_resize', { subAgentId: subAgentId, cols: cols, rows: rows });
    },
    // Envelope {ok, archived} — Rust returns the bare array.
    listArchivedSubAgents: function () {
      return call('subagent_list_archived')
        .then(function (list) { return { ok: true, archived: list || [] }; })
        .catch(function (e) { return { ok: false, error: String(e) }; });
    },
    clearArchivedSubAgent: function (parentSessionId, index) {
      return call('subagent_clear_archived', { parentSessionId: parentSessionId, index: index });
    },
    onSubAgentCreated: function (cb) { return on('subagent:created', cb); },
    // localStorage mirror of restartable sub-agents (the parked stash):
    // Rust pushes slim snapshots; the renderer persists them and hands them back
    // with restoreSubAgentStash at boot/wake.
    onSubAgentStashUpdated: function (cb) { return on('subagent:stash-updated', cb); },
    restoreSubAgentStash: function (sessionId, subAgents) {
      return call('subagent_restore_stash', { sessionId: sessionId, subAgents: subAgents });
    },
    onSubAgentStatus: function (cb) { return on('subagent:status', cb); },
    // ctl/MCP: "move me to a new session" (see agent_ctl::move_to_session).
    onCtlAgentMove: function (cb) { return on('ctl:agent-move', cb); },
    // ctl/MCP: bench (agent_ctl::bench).
    onCtlAgentBench: function (cb) { return on('ctl:agent-bench', cb); },
    onSubAgentUpdated: function (cb) { return on('subagent:updated', cb); },
    onSubAgentDestroyed: function (cb) { return on('subagent:destroyed', cb); },
    // Resume rejected by the CLI → relaunch + original prompt (warning toast).
    onSubAgentResumeFallback: function (cb) { return on('subagent:resume-fallback', cb); },
    // RAW output from the global channel, already statefully decoded per agent
    // (payload unchanged toward the webapp: { subAgentId, parentSessionId, data }).
    onSubAgentOutput: function (cb) { return pushCb(saOutCbs, cb); },

    // ── Worker chat (headless sub-agents) ────────────────────────────────
    // Envelope {ok, items} / {ok} / {ok:false, error}
    // — Rust returns bare values, the webapp checks res.ok.
    getWorkerTranscript: function (subAgentId) {
      return call('subagent_worker_transcript', { subAgentId: subAgentId })
        .then(function (items) { return { ok: true, items: items || [] }; })
        .catch(function (e) { return { ok: false, items: [], error: String(e) }; });
    },
    sendWorkerMessage: function (subAgentId, text) {
      return call('subagent_worker_send', { subAgentId: subAgentId, text: text })
        .then(function (accepted) {
          return accepted ? { ok: true } : { ok: false, error: 'A turn is already running' };
        })
        .catch(function (e) { return { ok: false, error: String(e) }; });
    },
    cancelWorkerTurn: function (subAgentId) {
      return call('subagent_worker_cancel', { subAgentId: subAgentId })
        .then(function () { return { ok: true }; })
        .catch(function (e) { return { ok: false, error: String(e) }; });
    },
    onWorkerItem: function (cb) { return on('subagent:worker-item', cb); },

    // ── Goal loop (goal-driven workers — autonomous evaluate-vs-goal) ────
    getGoalLoopState: function (subAgentId) {
      return call('subagent_goal_state', { subAgentId: subAgentId })
        .then(function (state) { return { ok: true, state: state }; })
        .catch(function (e) { return { ok: false, error: String(e) }; });
    },
    stopGoalLoop: function (subAgentId) {
      return call('subagent_goal_stop', { subAgentId: subAgentId })
        .then(function () { return { ok: true }; })
        .catch(function (e) { return { ok: false, error: String(e) }; });
    },
    onGoalLoopUpdate: function (cb) { return on('subagent:goal-update', cb); },

    // ── Sub-Agent Review ─────────────────────────────────────────────────
    requestSubAgentReview: function (request) { return call('subagent_review_request', request); },
    cancelSubAgentReview: function (runId) { return call('subagent_review_cancel', { runId: runId }); },
    listSubAgentReviews: function (subAgentId) {
      return call('subagent_review_list', { subAgentId: subAgentId });
    },
    onSubAgentReviewOutput: function (cb) { return on('subagent:review-output', cb); },
    onSubAgentReviewDone: function (cb) { return on('subagent:review-done', cb); },

    // ── Session Assets ───────────────────────────────────────────────────
    listAssets: function (cwd) { return call('assets_list', { cwd: cwd }); },
    uploadAssets: function (cwd, files) { return call('assets_upload', { cwd: cwd, files: files }); },
    deleteAsset: function (cwd, fileName) { return call('assets_delete', { cwd: cwd, fileName: fileName }); },
    renameAsset: function (cwd, oldName, newName) {
      return call('assets_rename', { cwd: cwd, oldName: oldName, newName: newName });
    },
    readAsset: function (cwd, fileName) { return call('assets_read', { cwd: cwd, fileName: fileName }); },
    readAssetBase64: function (cwd, fileName) { return call('assets_read_base64', { cwd: cwd, fileName: fileName }); },
    importAssetFromUrl: function (cwd, url, fileName) {
      return call('assets_import_from_url', { cwd: cwd, url: url, fileName: fileName });
    },
    importAssetPaths: function (cwd, paths) { return call('assets_import_paths', { cwd: cwd, paths: paths }); },
    openAssetsFolder: function (cwd) { return call('assets_open_folder', { cwd: cwd }); },
    fetchRemoteFile: function (cwd, path, open) { return call('remote_fetch_file', { cwd: cwd, path: path, open: open }); },
    remoteOutboxCollect: function (cwd, open) { return call('remote_outbox_collect', { cwd: cwd, open: open }); },
    remoteBridgeSetup: function (cwd) { return call('remote_bridge_setup', { cwd: cwd }); },
    remoteBridgeRemove: function (cwd) { return call('remote_bridge_remove', { cwd: cwd }); },

    // ── Editor ───────────────────────────────────────────────────────────
    detectEditors: function () { return call('editor_detect'); },
    openInEditor: function (editorCommand, cwd) {
      return call('editor_open', { editorCommand: editorCommand, cwd: cwd });
    },

    // ── Shell utilities ──────────────────────────────────────────────────
    showInFolder: function (folderPath) { return call('shell_show_in_folder', { folderPath: folderPath }); },
    openTerminalInFolder: function (cwd) { return call('shell_open_terminal', { cwd: cwd }); },
    openExternal: function (url) { return openExternalDedup(url); },
    downloadFile: function (url, name) {
      return call('download_url_to_downloads', { url: url, name: name, reveal: true });
    },
    clipboardWrite: function (text) { return call('clipboard_write', { text: text }); },
    clipboardRead: function () { return call('clipboard_read'); },
    clipboardWriteImage: function (dataUrl) { return call('clipboard_write_image', { dataUrl: dataUrl }); },
    clipboardReadImage: function () { return call('clipboard_read_image'); },
    installerWriteScript: function (content) { return call('installer_write_script', { content: content }); },

    // ── File System (code editor) ────────────────────────────────────────
    fsListDir: function (cwd) { return call('fs_list_dir', { cwd: cwd }); },
    fsListDirShallow: function (cwd, relPath) { return call('fs_list_dir_shallow', { cwd: cwd, relPath: relPath }); },
    fsReadFile: function (cwd, filePath) { return call('fs_read_file', { cwd: cwd, filePath: filePath }); },
    fsReadFileBase64: function (cwd, filePath) {
      return call('fs_read_file_base64', { cwd: cwd, filePath: filePath });
    },
    fsWriteFile: function (cwd, filePath, content) {
      return call('fs_write_file', { cwd: cwd, filePath: filePath, content: content });
    },
    fsSearchFiles: function (cwd, query) { return call('fs_search_files', { cwd: cwd, query: query }); },
    fsSearchPaths: function (cwd, query, opts) {
      var o = opts || {};
      return call('fs_search_paths', {
        cwd: cwd,
        query: query,
        includeDirs: o.includeDirs != null ? o.includeDirs : true,
        includeFiles: o.includeFiles != null ? o.includeFiles : true,
        maxResults: o.maxResults,
      });
    },
    fsSearchContent: function (cwd, query, maxResults, options) {
      return call('fs_search_content', { cwd: cwd, query: query, maxResults: maxResults, options: options || null });
    },
    fsDelete: function (cwd, filePath) { return call('fs_delete', { cwd: cwd, filePath: filePath }); },
    fsRename: function (cwd, oldPath, newPath) {
      return call('fs_rename', { cwd: cwd, oldPath: oldPath, newPath: newPath });
    },
    fsNewFile: function (cwd, filePath) { return call('fs_new_file', { cwd: cwd, filePath: filePath }); },
    fsNewFolder: function (cwd, folderPath) { return call('fs_new_folder', { cwd: cwd, folderPath: folderPath }); },
    fsDuplicate: function (cwd, filePath) { return call('fs_duplicate', { cwd: cwd, filePath: filePath }); },
    fsWatchStart: function (cwd) {
      return call('fs_watch_start', { cwd: cwd, onEvent: makeFsWatchChannel() });
    },
    fsWatchStop: function (cwd) { return call('fs_watch_stop', cwd ? { cwd: cwd } : {}); },
    onFsWatchEvent: function (cb) {
      // The wrapper passes a single arg: callback(payload)
      return pushCb(fsWatchCbs, cb);
    },

    // ── Device Workspaces ────────────────────────────────────────────────
    getDeviceWorkspace: function (sessionId) { return call('device_workspace_get', { sessionId: sessionId }); },
    listDeviceWorkspaces: function () { return call('device_workspace_list'); },
    upsertDeviceWorkspace: function (sessionId, localPath) {
      return call('device_workspace_upsert', { sessionId: sessionId, localPath: localPath });
    },
    updateDeviceWorkspace: function (id, localPath) {
      return call('device_workspace_update', { id: id, localPath: localPath });
    },
    deleteDeviceWorkspace: function (id) { return call('device_workspace_delete', { id: id }); },
    migrateDeviceWorkspaces: function () { return call('device_workspace_migrate'); },
    validateWorkspacePath: function (localPath) {
      return call('device_workspace_validate_path', { localPath: localPath });
    },

    // ── Access Control ───────────────────────────────────────────────────
    getDeviceId: function () { return call('access_control_get_device_id'); },

    // ── Claude Hooks (PUSH STREAMS) ──────────────────────────────────────
    onHookEvent: function (cb) { return on('hook:event', cb); },
    onNavigateSession: function (cb) { return on('hook:navigate-session', cb); },

    // ── Usage Center ─────────────────────────────────────────────────────
    getUsageSummary: function (window) { return call('usage_get_summary', { window: window }); },
    exportUsage: function (args) { return call('usage_export', args); },
    clearUsage: function () { return call('usage_clear'); },
    runUsageScan: function () { return call('usage_run_scan'); },
    // The usage ring has no event of its own: refresh on the token tracker's update.
    onUsageUpdated: function (cb) { return on('token:usage-updated', cb); },
    onUsageScanStatus: function (cb) { return on('usage:scan-status', cb); },

    // ── Token Efficiency ─────────────────────────────────────────────────
    getTokenStats: function (sessionId) { return call('token_get_stats', { sessionId: sessionId }); },
    getAllTokenStats: function () { return call('token_get_all_stats'); },
    recordTokenUsage: function (sessionId, data) {
      return call('token_record_usage', { sessionId: sessionId, data: data });
    },
    setTokenFlags: function (sessionId, flags) {
      return call('token_set_flags', { sessionId: sessionId, flags: flags });
    },
    onTokenUsageUpdated: function (cb) { return on('token:usage-updated', cb); },
    onTokenContextPressure: function (cb) { return on('token:context-pressure', cb); },
    requestTokenCompact: function (sessionId) { return call('token_request_compact', { sessionId: sessionId }); },

    // ── Optimization Controls ────────────────────────────────────────────
    getOptimizationStatus: function (sessionId) {
      return call('optimization_get_status', { sessionId: sessionId });
    },
    refreshOptimizationContext: function (sessionId) {
      return call('optimization_refresh_context', { sessionId: sessionId });
    },
    getFileCacheStats: function (sessionId) {
      return call('optimization_get_file_cache', { sessionId: sessionId });
    },

    // ── Provider Usage ───────────────────────────────────────────────────
    getProviderUsage: function (sessionId) { return call('provider_usage_get', { sessionId: sessionId }); },
    getAllProviderUsage: function () { return call('provider_usage_get_all'); },
    // userInitiated: true only for an explicit Refresh/Retry click — automatic
    // probes never launch the provider CLI (metrics.rs answers from cache).
    probeProviderUsage: function (sessionId, provider, userInitiated) {
      return call('provider_usage_probe', { sessionId: sessionId, provider: provider || null, userInitiated: userInitiated === true });
    },
    onProviderUsageUpdated: function (cb) { return on('provider-usage:updated', cb); },
    onProviderUsageProbeFailed: function (cb) { return on('provider-usage:probe-failed', cb); },

    // ── Desktop State ────────────────────────────────────────────────────
    saveDesktopState: function (data) { return call('desktop_state_save', { data: data }); },
    getDesktopState: function () { return call('desktop_state_get'); },

    // ── App OS settings (launch at login) ────────────────────────────────
    getAutoLaunch: function () { return call('app_get_auto_launch'); },
    setAutoLaunch: function (enabled) { return call('app_set_auto_launch', { enabled: enabled }); },

    // ── Context Snapshot ─────────────────────────────────────────────────
    generateContextSnapshot: function (workspacePath) {
      return call('context_snapshot_generate', { workspacePath: workspacePath });
    },
    getContextSnapshotStatus: function (workspacePath) {
      return call('context_snapshot_status', { workspacePath: workspacePath });
    },
    getContextSnapshot: function (workspacePath) {
      return call('context_snapshot_get', { workspacePath: workspacePath });
    },
    refreshContextSnapshot: function (workspacePath) {
      return call('context_snapshot_refresh', { workspacePath: workspacePath });
    },
    getContextSnapshotProviderSummary: function (workspacePath) {
      return call('context_snapshot_provider_summary', { workspacePath: workspacePath });
    },
    onContextSnapshotProgress: function (cb) { return on('context-snapshot:progress', cb); },
    onContextSnapshotComplete: function (cb) { return on('context-snapshot:complete', cb); },

    // ── Smart Actions ────────────────────────────────────────────────────
    detectSmartAction: function (prompt, workspacePath) {
      // The Rust command takes a `request` DTO (SmartActionRequest): without the
      // wrap the invoke fails deserialization and the webapp silently
      // "proceeds" without ever showing the smart-action modal.
      return call('smart_action_detect', {
        request: { prompt: prompt, workspacePath: workspacePath },
      });
    },
    executeSmartAction: function (sessionId, command) {
      return call('smart_action_execute', { sessionId: sessionId, command: command });
    },
    getSmartActionCommands: function (workspacePath) {
      return call('smart_action_commands', { workspacePath: workspacePath });
    },
    scanWorkspaceFolders: function (workspacePath, forceRefresh) {
      return call('smart_action_scan_folders', { workspacePath: workspacePath, forceRefresh: forceRefresh });
    },
    // parentSessionId: matched by id when given (two sessions can share a name).
    runSmartActionTerminal: function (parentSessionName, label, command, parentSessionId) {
      return call('smart_action_run_terminal', {
        parentSessionName: parentSessionName, label: label, command: command,
        parentSessionId: parentSessionId || null,
      });
    },

    // ── Agent Extensions (MCP / Skills / Plugins) ────────────────────────
    listCatalog: function (query) { return call('extensions_catalog_list', query || {}); },
    materializeExtensions: function (workspacePath, provider, selection) {
      return call('extensions_materialize', {
        req: { workspacePath: workspacePath, provider: provider, selection: selection },
      });
    },
    listInstalledExtensions: function (workspacePath) {
      return call('extensions_installed', { workspacePath: workspacePath });
    },
    listLocalSkills: function () { return call('extensions_local_skills', {}); },

    // ── Intent ───────────────────────────────────────────────────────────
    generateIntentPlan: function (params) { return call('intent_generate_plan', params); },
    enhanceIntentPrompt: function (params) { return call('intent_enhance_prompt', params); },

    // ── Shared Context (cross-provider) ──────────────────────────────────
    getSharedContext: function (workspacePath) {
      return call('shared_context_get', { workspacePath: workspacePath });
    },
    patchSharedContext: function (workspacePath, patch) {
      return call('shared_context_patch', { workspacePath: workspacePath, patch: patch });
    },
    clearSharedContext: function (workspacePath) {
      return call('shared_context_clear', { workspacePath: workspacePath });
    },
    getContextTransferPref: function (workspacePath, providerId) {
      return call('shared_context_get_pref', { workspacePath: workspacePath, providerId: providerId });
    },
    setContextTransferPref: function (workspacePath, providerId, pref) {
      return call('shared_context_set_pref', {
        workspacePath: workspacePath, providerId: providerId, pref: pref,
      });
    },
    onSharedContextChanged: function (cb) { return on('shared-context:changed', cb); },

    // ── Sub-agent context transfer (pre-spawn UX) ────────────────────────
    requestSpawnSubAgent: function (request) {
      return invoke('subagent_spawn_request', { request: request, onOutput: new Channel() });
    },
    // The spawn queue behind the context-transfer prompt is not implemented yet
    // (subagent_spawn_request always spawns directly), so nothing is ever pending.
    decideContextTransfer: function () {
      return Promise.resolve({ ok: false, error: 'context transfer is not available' });
    },
    listPendingSpawns: function () { return Promise.resolve({ ok: true, pending: [] }); },
    onContextTransferRequired: function (cb) { return on('subagent:context-transfer-required', cb); },
    onContextTransferDone: function (cb) { return on('subagent:context-transfer-done', cb); },

    // ── Knowledge Graph ──────────────────────────────────────────────────
    indexKnowledgeGraph: function (workspacePath) { return call('knowledge_index', { workspacePath: workspacePath }); },
    queryKnowledgeGraph: function (symbol, depth) { return call('knowledge_query', { symbol: symbol, depth: depth }); },
    findGraphPath: function (from, to) { return call('knowledge_find_path', { from: from, to: to }); },
    impactAnalysis: function (files) { return call('knowledge_impact_analysis', { files: files }); },
    getKnowledgeStats: function () { return call('knowledge_stats'); },
    getGraphOverview: function () { return call('knowledge_overview'); },
    onKnowledgeProgress: function (cb) { return on('knowledge:indexing-progress', cb); },
    onKnowledgeComplete: function (cb) { return on('knowledge:indexing-complete', cb); },

    // ── Semantic Search ──────────────────────────────────────────────────
    semanticSearchBrief: function (workspacePath, query, topK) {
      return call('semantic_search_brief', {
        workspacePath: workspacePath, query: query, topK: topK,
      });
    },
    semanticSearch: function (query, topK, maxTokens) {
      return call('semantic_search', { query: query, topK: topK, maxTokens: maxTokens });
    },
    indexSemanticEngine: function (workspacePath) { return call('semantic_index', { workspacePath: workspacePath }); },
    getSemanticStatus: function () { return call('semantic_status'); },
    onSemanticProgress: function (cb) { return on('semantic:embedding-progress', cb); },
    onSemanticReady: function (cb) { return on('semantic:ready', cb); },

    // ── Session Memory ───────────────────────────────────────────────────
    addMemoryEntry: function (entry) { return call('memory_add', { entry: entry }); },
    searchMemory: function (query, tags, topK) {
      return call('memory_search', { query: query, tags: tags, topK: topK });
    },
    searchMemoryByFiles: function (files) { return call('memory_search_files', { files: files }); },
    resolveMemoryEntry: function (entryId) { return call('memory_resolve', { entryId: entryId }); },
    getMemoryStats: function () { return call('memory_stats'); },
    pruneMemory: function () { return call('memory_prune'); },

    // ── Background Tasks ─────────────────────────────────────────────────
    onBackgroundTaskUpdate: function (cb) { return on('background-task:update', cb); },
    listBackgroundTasks: function (sessionId) { return call('background_task_list', { sessionId: sessionId }); },

    // ── Storage Management ───────────────────────────────────────────────
    storageAudit: function () { return call('storage_audit'); },
    storageCleanup: function (areas) { return call('storage_cleanup', areas ? { areas: areas } : undefined); },
    storageGetLastAudit: function () { return call('storage_get_last_audit'); },
    // System cleanup: removes PromptOps hooks from the provider configs it edited (each workspace's
    // .claude/settings.local.json, Gemini/Antigravity settings). Returns { ok, changed: [paths] }.
    uninstallIntegrations: function (workspacePaths) {
      return call('hook_uninstall_integrations', { workspacePaths: workspacePaths || [] });
    },

    // ── Auto-Update ──────────────────────────────────────────────────────
    checkForUpdates: function () { return call('update_check'); },
    downloadUpdate: function () { return call('update_download'); },
    installUpdate: function () { return call('update_install'); },
    getUpdateStatus: function () { return call('update_get_status'); },
    onUpdateAvailable: function (cb) { return on('update:available', cb); },
    onUpdateNotAvailable: function (cb) { return on('update:not-available', cb); },
    onUpdateProgress: function (cb) { return on('update:progress', cb); },
    onUpdateDownloaded: function (cb) { return on('update:downloaded', cb); },
    onUpdateError: function (cb) { return on('update:error', cb); },
    openManualDownload: function () { return call('update_open_manual_download'); },

    // ── SSH Connections ──────────────────────────────────────────────────
    sshList: function (sessionId) { return call('ssh_list', { sessionId: sessionId }); },
    sshSave: function (input) { return call('ssh_save', { input: input }); },
    sshDelete: function (id) { return call('ssh_delete', { id: id }); },
    sshTest: function (id) { return call('ssh_test', { id: id }); },
    sshSpawn: function (args) {
      var withCh = Object.assign({}, args, { onEvent: makeSshChannel() });
      return call('ssh_spawn', withCh);
    },
    sshWrite: function (sessionId, data) { return call('ssh_write', { sessionId: sessionId, data: data }); },
    sshResize: function (sessionId, cols, rows) {
      return call('ssh_resize', { sessionId: sessionId, cols: cols, rows: rows });
    },
    sshClose: function (sessionId) { return call('ssh_close', { sessionId: sessionId }); },
    sshListActive: function () { return call('ssh_list_active'); },
    onSshOutput: function (cb) { return pushCb(sshOutCbs, cb); },
    onSshClosed: function (cb) { return pushCb(sshClosedCbs, cb); },
    onSshError: function (cb) { return pushCb(sshErrCbs, cb); },

    // ── Remote sessions (SSH, beta) — browsing for the remote cwd picker ─
    remoteListDir: function (connId, path) { return call('remote_list_dir', { connId: connId, path: path }); },
    remoteHomeDir: function (connId) { return call('remote_home_dir', { connId: connId }); },
    remoteCreateFolder: function (connId, parentPath, folderName) {
      return call('remote_create_folder', { connId: connId, parentPath: parentPath, folderName: folderName });
    },
    remoteCheckProvider: function (connId, command) { return call('remote_check_provider', { connId: connId, command: command }); },
    remoteTestConnection: function (connId) { return call('remote_test_connection', { connId: connId }); },
    remoteCmdListDir: function (command, path) { return call('remote_cmd_list_dir', { command: command, path: path }); },
    remoteCmdCreateFolder: function (command, parentPath, folderName) {
      return call('remote_cmd_create_folder', { command: command, parentPath: parentPath, folderName: folderName });
    },
    remoteProbe: function (connId, command) { return call('remote_probe', { connId: connId || null, command: command || null }); },
    remoteShellExec: function (connId, command, cwd, line) {
      return call('remote_shell_exec', { connId: connId || null, command: command || null, cwd: cwd || '', line: line });
    },

    // ── Provider Accounts (multi-account per provider CLI) ───────────────
    listProviderAccounts: function () { return call('provider_account_list'); },
    listProviderAccountsBy: function (provider) {
      return call('provider_account_list_by_provider', { provider: provider });
    },
    getProviderAccount: function (id) { return call('provider_account_get', { id: id }); },
    getActiveProviderAccount: function (provider) {
      return call('provider_account_get_active', { provider: provider });
    },
    setActiveProviderAccount: function (id, provider) {
      return call('provider_account_set_active', { id: id, provider: provider });
    },
    createProviderAccount: function (input) { return call('provider_account_create', input); },
    duplicateProviderAccount: function (id, newName) {
      return call('provider_account_duplicate', { id: id, newName: newName });
    },
    renameProviderAccount: function (id, name) {
      return call('provider_account_rename', { id: id, name: name });
    },
    updateProviderAccount: function (id, patch) {
      return call('provider_account_update', { id: id, patch: patch });
    },
    deleteProviderAccount: function (id, opts) {
      return call('provider_account_delete', { id: id, deleteFiles: !!(opts && opts.deleteFiles) });
    },
    openProviderAccountFolder: function (id) { return call('provider_account_open_folder', { id: id }); },
    importProviderAccount: function (args) { return call('provider_account_import', args); },
    getProviderAccountCapabilities: function () { return call('provider_account_capabilities'); },
    onProviderAccountActiveChanged: function (cb) { return on('provider-account:active-changed', cb); },
    onProviderAccountListChanged: function (cb) { return on('provider-account:list-changed', cb); },

    // ── Diagnostics ──────────────────────────────────────────────────────
    getMemoryDiagnostics: function () { return call('diagnostics_memory'); },

    // ── Native menu ───────────────────────────────────────────────────────
    // The app menu items run nothing on the Rust side: they emit
    // `native:menu` and the webapp routes them to the actions it already has.
    onNativeMenu: function (cb) {
      // Like the other onX: the caller only gets the payload.
      return on('native:menu', function (_e, payload) { cb(payload); });
    },
    // Translated menu labels (key = item id, e.g. 'app:session-new').
    // Resend on every language change: the menu gets rebuilt.
    menuApplyLabels: function (labels) { return call('menu_apply_labels', { labels: labels || {} }); },
    // Call after opening a workspace: refreshes "Recent Workspaces".
    menuRefreshRecents: function () { return call('menu_refresh_recents'); },

    // ── System notifications + dock badge (Tauri only) ───────────────────
    // Automatic notifications (pending request) start from Rust: here there is
    // only the channel for explicit ones and for translated titles.
    notifyNative: function (title, body, force, sessionId) {
      return call('notify_native', { title: title, body: body, force: !!force, sessionId: sessionId || null });
    },
    notifySetBadge: function (count) { return call('notify_set_badge', { count: count | 0 }); },
    notifySetLabels: function (input, action) {
      return call('notify_set_labels', { input: input || null, action: action || null });
    },

    // ── Git watch (event-driven status, Tauri only) ──────────────────────
    // Replaces the git panel's 15s poll: the event only arrives when
    // something the status actually sees changes.
    gitWatchStart: function (cwd) { return call('git_watch_start', { cwd: cwd }); },
    gitWatchStop: function (cwd) { return call('git_watch_stop', { cwd: cwd }); },
    onGitChanged: function (cb) {
      return on('git:changed', function (_e, payload) { cb(payload); });
    },

    // ── System dialogs (only the cases that truly are) ───────────────────
    dialogSetCloseLabels: function (labels) {
      return call('dialog_set_close_labels', { labels: labels });
    },
    dialogConfirm: function (request) {
      return call('dialog_confirm', { request: request || {} });
    },
    dialogError: function (title, message) {
      return call('dialog_error', { title: title, message: message });
    },
  };

  window.promptops = api;

  // ── Encrypted backup & restore of local data (local_backup.rs) ─────────
  // The passphrase goes to the native side only; the file never passes here.
  api.localBackupPickFile = function (save) {
    return call('local_backup_pick_file', { save: !!save });
  };
  api.localBackupExport = function (path, passphrase) {
    return call('local_backup_export', { path: path, passphrase: passphrase });
  };
  api.localBackupImport = function (path, passphrase, mode) {
    return call('local_backup_import', { path: path, passphrase: passphrase, mode: mode });
  };

  // ── System context menu ───────────────────────────────────────────────
  // Right-click on a text field or on a selection opens the system menu;
  // elsewhere no menu (the WKWebView default would offer Reload / Inspect
  // Element), except where the webapp has its own menu.
  //
  // Bubble phase and bail out on defaultPrevented: components with their own menu
  // (xterm, sidebar, git explorer) call preventDefault and win.
  window.addEventListener('contextmenu', function (e) {
    if (e.defaultPrevented) return;

    var target = e.target || null;
    var tag = target && target.tagName ? target.tagName.toUpperCase() : '';
    var type = (target && target.type ? String(target.type) : '').toLowerCase();
    // non-text inputs (checkbox, radio, range…) have nothing to cut.
    var NON_TEXT = ['checkbox', 'radio', 'range', 'color', 'file', 'button', 'submit', 'reset'];
    var editable =
      tag === 'TEXTAREA' ||
      (tag === 'INPUT' && NON_TEXT.indexOf(type) === -1) ||
      !!(target && target.isContentEditable);

    var selection = '';
    try {
      selection = window.getSelection ? String(window.getSelection()) : '';
    } catch (_) {}
    var hasSelection = selection.trim().length > 0;

    // Outside text fields and selections: no menu at all. WKWebView's default
    // one (Reload / Inspect Element) must never show up.
    e.preventDefault();
    if (!editable && !hasSelection) return;
    invoke('menu_popup', { kind: editable ? 'edit' : 'selection' }).catch(function () {});
  });

  // ── Titlebar ──────────────────────────────────────────────────────────
  // No DOM-side compensation: the window uses the full system title bar
  // (TitleBarStyle::Visible, see lib.rs), so the webview already starts below the
  // traffic lights and double-clicking the bar resizes like in any macOS app.
  // This is where the `#po-native-titlebar` strip for the overlay variant lived: if
  // that route is tried again, this is the place (and NOT the shared webapp).

  // ── External links ─────────────────────────────────────────────────────
  // In wry/WKWebView a click on <a target="_blank"> and window.open() are
  // silent no-ops: no window, no browser. Here we route them with an
  // allowlist: http/https/mailto → system browser via shell_open_external.

  var EXT_PROTOCOLS = ['http:', 'https:', 'mailto:'];
  var lastExtUrl = '';
  var lastExtAt = 0;

  /** Opens an external URL only once even if several handlers fire on the
      same click (capture interceptor + the app's (click), or the webapp's
      "if (!win || win.closed) window.open(...)" fallbacks). */
  function openExternalDedup(url) {
    var now = Date.now();
    if (url === lastExtUrl && now - lastExtAt < 400) return Promise.resolve();
    lastExtUrl = url;
    lastExtAt = now;
    return call('shell_open_external', { url: url });
  }

  /** true if the URL must be opened outside the app (allowed scheme and not
      same-origin: internal links stay in-app navigation). */
  function isExternalUrl(u) {
    if (EXT_PROTOCOLS.indexOf(u.protocol) < 0) return false;
    return u.protocol === 'mailto:' || u.origin !== location.origin;
  }

  function anchorFromEvent(e) {
    var path = e.composedPath ? e.composedPath() : null; // shadow-DOM safe
    if (path) {
      for (var i = 0; i < path.length; i++) {
        if (path[i] && path[i].tagName === 'A') return path[i];
      }
      return null;
    }
    var t = e.target;
    return t && t.closest ? t.closest('a') : null;
  }

  function interceptAnchor(e) {
    var a = anchorFromEvent(e);
    if (!a || a.target !== '_blank' || !a.href) return;
    if (a.hasAttribute('download')) return; // leave it to the webview
    var u;
    try {
      u = new URL(a.href, location.href);
    } catch (_) {
      return;
    }
    if (!isExternalUrl(u)) return;
    // Only preventDefault, NEVER stopPropagation: the app's handlers on the
    // same click (menu close, analytics) must keep running.
    e.preventDefault();
    openExternalDedup(u.href);
  }

  // capture: runs before the Angular handlers. Cmd/Ctrl/Shift-click and middle
  // click are "new window intent" → same routing as a normal click.
  window.addEventListener('click', interceptAnchor, true);
  window.addEventListener('auxclick', function (e) {
    if (e.button === 1) interceptAnchor(e);
  }, true);

  // window.open: for external URLs returns a fake WindowProxy (closed:false)
  // so the webapp's "popup blocked?" fallbacks don't open twice.
  var nativeOpen = window.open ? window.open.bind(window) : function () { return null; };
  window.open = function (url, target, features) {
    try {
      if (url) {
        var u = new URL(String(url), location.href);
        if (isExternalUrl(u)) {
          openExternalDedup(u.href);
          return {
            closed: false,
            close: function () { this.closed = true; },
            focus: function () {},
            blur: function () {},
          };
        }
        // Terminal links (OSC 8) and plugin or agent text reach here: `javascript:`, `data:`,
        // `file:` and other schemes never open, whatever the webview would do with them.
        if (u.origin !== location.origin && u.protocol !== 'about:' && u.protocol !== 'blob:') return null;
      }
    } catch (_) {
      return null;
    }
    return nativeOpen(url, target, features);
  };

  // ── Native cursor (macOS) ─────────────────────────────────────────────
  // WKWebView delegates the cursor to AppKit via cursor rects and inside wry that
  // chain breaks: the CSS `cursor: pointer` never reaches the screen and
  // the arrow stays. We watch the computed cursor under the pointer and
  // call the native side ONLY when it changes — one IPC per hover transition, not
  // one per mousemove.
  // navigator.platform is deprecated and in some WebKit builds returns empty: if
  // we gated on that alone the fallback would never register.
  if (window.__PROMPTOPS_OS__
    ? window.__PROMPTOPS_OS__ === 'darwin'
    : /Mac/i.test(navigator.platform) || /Mac OS X/i.test(navigator.userAgent)) {
    var lastCursor = '';
    var cursorPending = false;
    var lastTarget = null;
    var cursorLogged = false;
    var syncCursor = function (el) {
      var css = 'default';
      try {
        css = window.getComputedStyle(el).cursor || 'default';
      } catch (_) {}
      // Composite values (`url(...), pointer`) keep only the fallback.
      var comma = css.lastIndexOf(',');
      if (comma !== -1) css = css.slice(comma + 1).trim();
      if (css === lastCursor) return;
      lastCursor = css;
      // A single line on the first change: confirms in the logs that the fallback is
      // active (if missing, the block never registered).
      if (!cursorLogged) {
        cursorLogged = true;
        try {
          invoke('bridge_debug', { message: 'cursor fallback active, first value=' + css });
        } catch (_) {}
      }
      invoke('set_native_cursor', { name: css }).catch(function (e) {
        try { invoke('bridge_debug', { message: 'set_native_cursor KO: ' + e }); } catch (_) {}
      });
    };
    window.addEventListener(
      'mousemove',
      function (e) {
        // Same element as the previous frame → nothing to recompute.
        if (e.target === lastTarget || cursorPending) return;
        lastTarget = e.target;
        cursorPending = true;
        requestAnimationFrame(function () {
          cursorPending = false;
          if (lastTarget) syncCursor(lastTarget);
        });
      },
      true,
    );
    // Leaving the window, AppKit restores the arrow on its own: reset the
    // cache, otherwise on re-entering the same element we would not re-emit.
    window.addEventListener('mouseout', function (e) {
      if (!e.relatedTarget) {
        lastCursor = '';
        lastTarget = null;
      }
    });
  }

  // Cmd+R (mac) / F5 and Ctrl+Shift+R (win/linux) → reload webview.
  // Plain Ctrl+R reloads only outside the terminal: inside xterm it is the
  // shell's reverse-search (and Claude Code's history).
  window.addEventListener('keydown', function (e) {
    var isMac = window.__PROMPTOPS_OS__
      ? window.__PROMPTOPS_OS__ === 'darwin'
      : /Mac/i.test(navigator.platform);
    var isR = e.key === 'r' || e.key === 'R';
    var inTerminal = !!(e.target && e.target.closest && e.target.closest('.xterm'));
    var reload =
      (isMac && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && isR) ||
      (!isMac && e.key === 'F5') ||
      (!isMac && e.ctrlKey && e.shiftKey && isR) ||
      (!isMac && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && isR && !inTerminal);
    if (!reload) return;
    e.preventDefault();
    e.stopPropagation();
    window.location.reload();
  }, true);
})();
