#!/usr/bin/env node
/* Compile + run C with the same in-browser toolchain the site uses: Clang
   built for WebAssembly (@yowasp/clang) targeting wasm32-wasi, run through
   js/c-wasi.js. tools/build_c.py --toolchain wasm drives it, so every
   solution is verified exactly the way a visitor's browser will run it.

   Setup (once):   npm --prefix tools install

   Protocol: one JSON request per stdin line, one JSON reply per stdout line.
     → {id, source, flags?: [...], run?: bool (default true),
        tests?: n            harness program: run tests 0..n-1, one instance each
        timeoutMs?: number}  per test (harness) or whole run (plain program)
     ← {id, compile_error}                               didn't compile
     ← {id, warnings, stdout?, stderr?, code?, timeout?}  compiled (and ran)
   Harness programs reply with the same stdout the native harness prints, so
   c-harness.js parseOutput() reads both. */
import { createRequire } from 'node:module';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import readline from 'node:readline';

const require = createRequire(import.meta.url);
const cWasi = require('../js/c-wasi.js');

if (!isMainThread) {
  // ---- run worker: one fresh instance per test, a message after each ----
  const { bytes, from, n, plain } = workerData;
  const mod = new WebAssembly.Module(bytes);
  if (plain) {
    parentPort.postMessage({ plain: cWasi.run(mod, { args: ['prog'] }) });
  } else {
    for (let i = from; i < n; i++) {
      parentPort.postMessage({ i, res: cWasi.run(mod, { args: cWasi.testArgs(i) }) });
    }
  }
} else {
  // stdout is the reply channel; YoWASP logs its resource loading with console.log.
  console.log = (...a) => console.error(...a);
  if (cWasi.MARK !== require('../js/c-harness.js').MARK) throw new Error('c-wasi.js MARK out of sync with c-harness.js');
  let clang;
  try {
    ({ commands: { clang } } = await import('@yowasp/clang'));
  } catch (e) {
    process.stderr.write('c_wasm.mjs: @yowasp/clang not installed. Run: npm --prefix tools install\n');
    process.exit(2);
  }

  async function compile(source, flags, run) {
    let diag = '';
    const dec = new TextDecoder();
    const out = run ? 'prog.wasm' : 'prog.o';
    const args = [...cWasi.CLANG_ARGS, ...flags, ...(run ? [] : ['-c']), '-o', out, 'prog.c', ...(run ? cWasi.LINK_LIBS : [])];
    try {
      const files = await clang(args, { 'prog.c': source }, {
        stdout: b => { if (b) diag += dec.decode(b, { stream: true }); },
        stderr: b => { if (b) diag += dec.decode(b, { stream: true }); },
        fetchProgress: () => {},
        decodeASCII: false
      });
      return { bytes: files[out], diag };
    } catch (e) {
      if (typeof e.code === 'number') return { error: diag || `clang exited with ${e.code}` };
      throw e;
    }
  }

  // Run harness tests 0..n-1. A test that runs past timeoutMs gets the
  // time-limit error; the worker is killed and a new one resumes after it.
  function runTests(bytes, n, timeoutMs) {
    return new Promise(resolve => {
      const outs = [];
      let next = 0;
      const step = () => {
        if (next >= n) { resolve(outs.join('')); return; }
        const w = new Worker(new URL(import.meta.url), { workerData: { bytes, from: next, n } });
        let timer;
        const arm = () => { clearTimeout(timer); timer = setTimeout(onTimeout, timeoutMs); };
        const onTimeout = () => {
          w.removeAllListeners(); w.terminate();
          outs[next] = cWasi.testOutput(next, { stdout: '', crash: cWasi.MSG.timeout });
          next++; step();
        };
        w.on('message', ({ i, res }) => {
          outs[i] = cWasi.testOutput(i, res); next = i + 1;
          if (next >= n) { clearTimeout(timer); w.terminate(); resolve(outs.join('')); } else arm();
        });
        w.on('error', e => {
          clearTimeout(timer); w.removeAllListeners(); w.terminate();
          outs[next] = cWasi.testOutput(next, { stdout: '', crash: cWasi.crashMessage(e) });
          next++; step();
        });
        arm();
      };
      step();
    });
  }

  function runPlain(bytes, timeoutMs) {
    return new Promise(resolve => {
      const w = new Worker(new URL(import.meta.url), { workerData: { bytes, plain: true } });
      const timer = setTimeout(() => { w.terminate(); resolve({ timeout: true }); }, timeoutMs);
      w.on('message', ({ plain }) => {
        clearTimeout(timer); w.terminate();
        const stderr = plain.stderr + (plain.crash ? (plain.stderr ? '\n' : '') + plain.crash + '\n' : '');
        resolve({ stdout: plain.stdout, stderr, code: plain.exitCode });
      });
      w.on('error', e => { clearTimeout(timer); resolve({ stdout: '', stderr: String(e), code: 1 }); });
    });
  }

  async function handle(req) {
    const run = req.run !== false;
    const c = await compile(req.source, req.flags || [], run);
    if (c.error !== undefined) return { compile_error: c.error };
    const res = { warnings: c.diag };
    if (!run) return res;
    if (typeof req.tests === 'number') {
      res.stdout = await runTests(c.bytes, req.tests, req.timeoutMs || 10000);
      res.stderr = ''; res.code = 0;
    } else {
      Object.assign(res, await runPlain(c.bytes, req.timeoutMs || 60000));
    }
    return res;
  }

  // Requests are handled one at a time, in order (clang runs on this thread).
  const rl = readline.createInterface({ input: process.stdin });
  let chain = Promise.resolve();
  rl.on('line', line => {
    if (!line.trim()) return;
    chain = chain.then(async () => {
      let req;
      try { req = JSON.parse(line); } catch (e) { return; }
      let reply;
      try { reply = await handle(req); } catch (e) { reply = { compile_error: 'c_wasm.mjs: ' + (e && e.stack || e) }; }
      process.stdout.write(JSON.stringify({ id: req.id, ...reply }) + '\n');
    });
  });
  rl.on('close', () => { chain.then(() => process.exit(0)); });
}
