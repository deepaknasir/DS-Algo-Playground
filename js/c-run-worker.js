/* c-run-worker.js — runs a compiled wasm32-wasi C program (see js/c-wasi.js).
   Disposable: DSA.cdnLoader.runC terminates it when a program runs too long
   (wasm can't be interrupted from inside) and starts a fresh one if more
   tests remain.

   Message in (one per worker):
     { mode: 'plain', wasm, stdin }       run main() once
     { mode: 'tests', wasm, from, n }     harness program: run tests from..n-1,
                                          each in a fresh instance
   Messages out:
     { out: { fd, text } }                program output so far, streamed so it
                                          survives the worker being killed
     { plain: result }                    plain run finished
     { i, res: result }                   test i finished
   result = { stdout, stderr, exitCode, crash } as returned by DSA.cWasi.run */

importScripts('c-wasi.js');

// Output is posted in batches: right away if the program has been quiet for
// a moment (so "print, then loop forever" still shows the print), otherwise
// at most every 50 ms.
var FLUSH_MS = 50;
var pending = { 1: '', 2: '' };
var lastFlush = 0;
var dec = { 1: new TextDecoder(), 2: new TextDecoder() };

function flush() {
  for (var fd = 1; fd <= 2; fd++) {
    if (pending[fd]) { self.postMessage({ out: { fd: fd, text: pending[fd] } }); pending[fd] = ''; }
  }
  lastFlush = Date.now();
}

function onOutput(fd, bytes) {
  pending[fd] += dec[fd].decode(bytes, { stream: true });
  if (Date.now() - lastFlush >= FLUSH_MS) flush();
}

self.onmessage = function(e) {
  var m = e.data || {};
  var mod = new WebAssembly.Module(m.wasm);
  if (m.mode === 'plain') {
    var res = DSA.cWasi.run(mod, { args: ['prog'], stdin: m.stdin || '', onOutput: onOutput });
    self.postMessage({ plain: res });
    return;
  }
  for (var i = m.from; i < m.n; i++) {
    pending[1] = pending[2] = ''; // the previous test's leftovers are in its result
    dec = { 1: new TextDecoder(), 2: new TextDecoder() };
    lastFlush = 0;
    self.postMessage({ start: i });
    var r = DSA.cWasi.run(mod, { args: DSA.cWasi.testArgs(i), onOutput: onOutput });
    self.postMessage({ i: i, res: r });
  }
};
