const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../../web/node_modules/typescript');
const source = fs.readFileSync(path.join(__dirname, '../../web/src/app/core/helper/terminal-replay-stream.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
const exportsObject = {};
vm.runInNewContext(compiled.outputText, { exports: exportsObject, TextDecoder });
const { TerminalReplayStream } = exportsObject;
const enc = new TextEncoder();
const chunk = (data, endOffset) => ({ data, bytes: enc.encode(data), endOffset });

test('output queued before snapshot completion is applied exactly once, including ANSI', () => {
  const stream = new TerminalReplayStream();
  const queued = [chunk('abc', 3), chunk('\x1b[2Jdef', 10), chunk('ghi', 13)];
  let rendered = stream.snapshot(chunk('abc\x1b[2Jdef', 10));
  for (const event of queued) rendered += stream.output(event);
  assert.equal(rendered, 'abc\x1b[2Jdefghi');
});

test('a chunk straddling the snapshot only contributes its new suffix', () => {
  const stream = new TerminalReplayStream();
  assert.equal(stream.snapshot(chunk('abc', 3)), 'abc');
  assert.equal(stream.output(chunk('bcdef', 6)), 'def');
  assert.equal(stream.output(chunk('bcdef', 6)), '');
});

test('UTF-8 split at the snapshot boundary survives partial overlap', () => {
  const bytes = enc.encode('a🙂z');
  const stream = new TerminalReplayStream();
  const snapshot = stream.snapshot({ data: '', bytes: bytes.subarray(0, 3), endOffset: 3 });
  const live = stream.output({ data: '', bytes: bytes.subarray(1), endOffset: bytes.length });
  assert.equal(snapshot + live, 'a🙂z');
});

test('independent renderers do not consume each other’s output', () => {
  const a = new TerminalReplayStream();
  const b = new TerminalReplayStream();
  a.snapshot(chunk('abcd', 4));
  b.snapshot(chunk('ab', 2));
  assert.equal(a.output(chunk('cdef', 6)), 'ef');
  assert.equal(b.output(chunk('cdef', 6)), 'cdef');
});

test('failed snapshot and string-only events still deliver live output', () => {
  const stream = new TerminalReplayStream();
  assert.equal(stream.output(chunk('abc', 3)), 'abc');
  assert.equal(stream.snapshot({ data: 'history' }), 'history');
  assert.equal(stream.output({ data: 'live' }), 'live');
});

test('real bridge exposes raw offsets and a buffer read never mutes another subscriber', async () => {
  let channel;
  let resolveBuffer;
  const window = {
    addEventListener() {},
    __TAURI__: {
      core: {
        Channel: class {},
        invoke(command, args) {
          if (command === 'session_create') {
            channel = args.onOutput;
            return Promise.resolve({ session: { id: 's' } });
          }
          if (command === 'session_buffer') return new Promise(resolve => { resolveBuffer = resolve; });
          return Promise.resolve({});
        },
      },
      event: { listen: () => Promise.resolve(() => {}) },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src-tauri/src/promptops_bridge.js'), 'utf8'), {
    window, navigator: { platform: 'Linux', userAgent: '' }, console,
    TextDecoder, TextEncoder, ArrayBuffer, Uint8Array, DataView, URL,
    setTimeout, clearTimeout,
  });
  const api = window.promptops;
  await api.createSession({});
  const received = [];
  api.onSessionOutput((_, event) => received.push(event));
  // Live frames carry their start offset (u64 LE) before the PTY bytes.
  const frame = (start, text) => {
    const body = enc.encode(text);
    const out = new Uint8Array(8 + body.length);
    new DataView(out.buffer).setUint32(0, start, true);
    out.set(body, 8);
    return out;
  };
  const request = api.getSessionBuffer('s');
  channel.onmessage(frame(0, 'abc'));
  const payload = new Uint8Array(14);
  new DataView(payload.buffer).setUint32(0, 6, true);
  payload.set(enc.encode('abcdef'), 8);
  resolveBuffer(payload);
  const snapshot = await request;
  channel.onmessage(frame(3, 'def'));
  assert.equal(received.map(event => event.data).join(''), 'abcdef');
  assert.equal(snapshot.endOffset, 6);
  assert.equal(received[1].endOffset, 6);
  const stream = new TerminalReplayStream();
  assert.equal(stream.snapshot(snapshot) + received.map(event => stream.output(event)).join(''), 'abcdef');
});

// Exercise the actual lifecycle methods without bootstrapping Angular or a GPU.
const componentSource = fs.readFileSync(path.join(__dirname, '../../web/src/app/views/admin-core/sessions/session-terminal/session-terminal.component.ts'), 'utf8');
const componentCode = ts.transpileModule(componentSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true },
});
const componentExports = {};
vm.runInNewContext(componentCode.outputText, {
  exports: componentExports,
  require: name => name === '@angular/core' ? new Proxy({}, { get: () => () => () => {} }) : {},
  console, setTimeout, clearTimeout,
});
const prototype = componentExports.SessionTerminalComponent.prototype;
function signal(value) {
  const read = () => value;
  read.set = next => { value = next; };
  read.update = fn => { value = fn(value); };
  return read;
}

test('session switch during the first pending buffer request starts a new initialization', () => {
  const component = Object.create(prototype);
  let inits = 0;
  let teardowns = 0;
  Object.assign(component, {
    sessionService: { isTauri: false },
    initTerminal: () => { inits++; return new Promise(() => {}); },
    teardown: () => { teardowns++; },
    endResumeVeil() {},
  });
  component.ngAfterViewInit();
  component.ngOnChanges({ sessionId: { previousValue: 'a', currentValue: 'b', firstChange: false } });
  assert.equal(inits, 2);
  assert.equal(teardowns, 1);
});

test('the old slot stays visible until commit and stale commits cannot affect a new session', () => {
  const component = Object.create(prototype);
  let disposed = 0;
  Object.assign(component, {
    xterm: { options: {} },
    activeSlot: signal('a'), visibleSlot: signal('a'),
    ptyResizeTimer: null, replayGateTimer: null, tuiRepaintTimer: null,
    swapCapTimer: null, setupGeneration: 2,
    disposeDetachedInstance: () => { disposed++; },
  });
  component.detachCurrent();
  component.swapGen = 2;
  assert.equal(component.activeSlot(), 'b');
  assert.equal(component.visibleSlot(), 'a');
  component.commitSwap(1);
  assert.equal(component.visibleSlot(), 'a');
  assert.equal(disposed, 0);
  component.commitSwap(2);
  assert.equal(component.visibleSlot(), 'b');
  assert.equal(disposed, 1);
  component.commitSwap(2);
  assert.equal(disposed, 1);
});
