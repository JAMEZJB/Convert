// Runs without app imports, dependencies, network, DOM, or Electron startup.
// Evaluate the actual orchestration/handler bodies, never a copied implementation.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const traversal = stripTypeScriptTypes(main.slice(
  main.indexOf('let deadEndAttempts:'), main.indexOf('async function initSupportedFormats()'),
));
const ui = readFileSync(new URL('../src/ui/pages/Conversion/index.tsx', import.meta.url), 'utf8');
const handleConvert = ui.slice(ui.indexOf('  const handleConvert = async () => {'),
  ui.indexOf('  const canProceed ='));
const quiet = { log() {}, error() {}, warn() {} };

function engine({ stage, fail = false, cancel = true } = {}) {
  const controller = new AbortController();
  let conversions = 0;
  const input = { mime: 'text/plain', format: 'txt', from: true };
  const output = { mime: 'application/example', format: 'out' };
  const handler = {
    name: 'synthetic', ready: stage !== 'init', supportedFormats: [input],
    async init() { this.ready = true; if (cancel) controller.abort(); },
    async doConvert() {
      conversions++;
      if (cancel) controller.abort();
      if (fail) throw new Error('synthetic handler failure');
      return [{ name: 'result.out', bytes: new Uint8Array([1]) }];
    },
  };
  const from = { handler, format: input }, to = { handler, format: output };
  const graph = {
    clearDeadEndPaths() {}, addDeadEndPath() {},
    async *searchPath() { yield [from, to]; },
  };
  const window = { supportedFormatCache: new Map([[handler.name, [input]]]), traversionGraph: graph };
  const context = vm.createContext({ window, DOMException, console: quiet,
    requestAnimationFrame: fn => fn(), Mode: { value: 0 }, ModeEnum: { Simple: 0 },
    ProgressStore: { progress() {}, createContext() { return { log() {},
      throwIfAborted() { controller.signal.throwIfAborted(); } }; } },
  });
  vm.runInContext(traversal, context);
  return { controller, graph, calls: () => conversions,
    run: () => window.tryConvertByTraversing([{ bytes: new Uint8Array([2]) }], from, to, controller.signal) };
}

for (const stage of ['init', 'convert']) {
  test(`cancel during ${stage} cannot return output`, async () => {
    const e = engine({ stage });
    await assert.rejects(e.run(), { name: 'AbortError' });
    assert.equal(e.calls(), stage === 'init' ? 0 : 1);
  });
}
test('cancelled handler rejection remains cancellation', async () => {
  const e = engine({ stage: 'convert', fail: true });
  await assert.rejects(e.run(), { name: 'AbortError' });
});
test('already cancelled traversal does not start conversion', async () => {
  const e = engine(); e.controller.abort();
  await assert.rejects(e.run(), { name: 'AbortError' });
  assert.equal(e.calls(), 0);
});
test('cancelled empty path search is not a missing route', async () => {
  const e = engine();
  e.graph.searchPath = async function* () { e.controller.abort(); };
  await assert.rejects(e.run(), { name: 'AbortError' });
});
test('successful conversion still returns actual result', async () => {
  const result = await engine({ cancel: false }).run();
  assert.equal(result.files[0].name, 'result.out');
});

function uiRun({ stage, sameFormat = false, cancel = true, missing = false, reject = false }) {
  let downloads = 0, popups = 0;
  const controller = new AbortController();
  const input = { mime: 'text/plain', format: 'txt' };
  const output = sameFormat ? input : { mime: 'application/example', format: 'out' };
  const file = { name: 'input.txt', async arrayBuffer() {
    if (cancel && stage === 'read') controller.abort();
    if (reject && stage === 'read') throw new Error('synthetic read failure');
    return new Uint8Array([1]).buffer;
  } };
  const context = vm.createContext({ console: quiet, DOMException, Uint8Array,
    fromOption: [input, {}], toOption: [output, {}], firstFile: file, files: [file],
    setIsConverting() {}, setStep() {}, ConversionInProgress: { value: false },
    ProgressStore: { controller, reset() {} }, PopupData: { value: null },
    downloadFile() { downloads++; }, openPopup() { popups++; },
    window: { async tryConvertByTraversing() {
      if (cancel) controller.abort();
      if (reject) throw new Error('synthetic conversion failure');
      return missing ? null : { files: [{ bytes: new Uint8Array([1]), name: 'out' }],
        path: [{ format: input }, { format: output }] };
    } },
  });
  vm.runInContext(`${handleConvert}\nglobalThis.run = handleConvert;`, context);
  return { async run() { await context.run(); return { downloads, popups,
    busy: context.ConversionInProgress.value, popup: context.PopupData.value }; } };
}
for (const options of [
  { stage: 'read' }, { stage: 'read', sameFormat: true },
  { stage: 'convert' }, { stage: 'convert', missing: true },
  { stage: 'read', reject: true }, { stage: 'convert', reject: true },
]) {
  test(`UI cancellation suppresses publication ${JSON.stringify(options)}`, async () => {
    const result = await uiRun(options).run();
    assert.deepEqual(result, { downloads: 0, popups: 0, busy: false, popup: null });
  });
}
test('UI ordinary success still downloads and announces', async () => {
  const result = await uiRun({ cancel: false }).run();
  assert.equal(result.downloads, 1); assert.equal(result.popups, 1);
  assert.equal(result.popup.title, 'Conversion complete!'); assert.equal(result.busy, false);
});
test('UI missing route still reports conversion failure', async () => {
  const result = await uiRun({ cancel: false, missing: true }).run();
  assert.equal(result.downloads, 0); assert.equal(result.popups, 1);
  assert.equal(result.popup.title, 'Conversion failed'); assert.equal(result.busy, false);
});
