/* c-compile-worker.js — compiles C to wasm32-wasi in the browser with Clang
   built for WebAssembly (YoWASP Clang). Nothing is sent anywhere: the
   toolchain is downloaded once from jsDelivr (~23 MB compressed, then served
   from the browser cache) and runs locally. Driven by DSA.cdnLoader.runC
   (cdn-loader.js).

   This worker is long-lived so Clang stays loaded between runs. Programs
   never run here: they run in a separate, disposable c-run-worker.js, so
   killing a runaway program doesn't throw away the compiler.

   Messages in:
     { id, mode: 'warmup' }        → download + prepare the toolchain
     { id, mode: 'compile', source }
   Messages out:
     { progress: { done, total } }               toolchain download (no id)
     { id, ready: true }                          warmup finished
     { id, wasm: ArrayBuffer, diagnostics }       compiled (warnings, if any)
     { id, compileError }                         didn't compile
     { id, error }                                toolchain failed to load */

importScripts('c-wasi.js');

// Pinned: tools/package.json pins the same version for tools/build_c.py.
var CLANG_URL = 'https://cdn.jsdelivr.net/npm/@yowasp/clang@22.0.0-git20695-13/gen/bundle.js';

var clangReady = null;
function getClang() {
  if (!clangReady) {
    clangReady = import(CLANG_URL).then(function(mod) {
      var clang = mod.commands.clang;
      // run(null) only fetches the toolchain, reporting download progress.
      return Promise.resolve(clang(null, {}, {
        fetchProgress: function(s) {
          self.postMessage({ progress: { done: s.doneLength, total: s.totalLength } });
        }
      })).then(function() { return clang; });
    });
    clangReady.catch(function() { clangReady = null; }); // let a later run retry
  }
  return clangReady;
}

function compile(clang, source) {
  var diag = '';
  var dec = new TextDecoder();
  var collect = function(b) { if (b) diag += dec.decode(b, { stream: true }); };
  var args = DSA.cWasi.CLANG_ARGS.concat(['-o', 'prog.wasm', 'prog.c'], DSA.cWasi.LINK_LIBS);
  return Promise.resolve()
    .then(function() {
      return clang(args, { 'prog.c': source }, { stdout: collect, stderr: collect, decodeASCII: false });
    })
    .then(function(files) {
      var wasm = files['prog.wasm'];
      var buf = wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength);
      return { wasm: buf, diagnostics: diag };
    }, function(e) {
      // YoWASP throws Exit (with a numeric code) when clang exits non-zero.
      if (e && typeof e.code === 'number') return { compileError: diag || ('clang exited with code ' + e.code) };
      throw e;
    });
}

// One request at a time: Clang runs on this thread anyway.
var queue = Promise.resolve();
self.onmessage = function(e) {
  var msg = e.data || {};
  var id = msg.id;
  queue = queue.then(function() {
    return getClang().then(function(clang) {
      if (msg.mode !== 'compile') { self.postMessage({ id: id, ready: true }); return; }
      return compile(clang, msg.source || '').then(function(r) {
        r.id = id;
        self.postMessage(r, r.wasm ? [r.wasm] : []);
      });
    }).catch(function(err) {
      self.postMessage({ id: id, error: String((err && err.message) || err) });
    });
  });
};
