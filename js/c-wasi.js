/* c-wasi.js — runs a C program compiled to wasm32-wasi, with no network and
   no SharedArrayBuffer. Shared by the browser (the C run worker) and the
   offline verifier (tools/c_wasm.mjs → node), so both run programs exactly
   the same way.

   It contains:
     - CLANG_ARGS     the clang flags every C program is built with
     - run(module, …) a minimal WASI preview1 shim (args, stdin, stdout/stderr,
                      clock, random, exit), one fresh instance per call
     - testOutput(…)  turns one harness test run into the "@@DSA@@|i|…" lines
                      that DSA.cHarness.parseOutput already understands

   Why one fresh instance per test: wasm has no signals, so the native
   harness's sigsetjmp crash recovery isn't available. A crash is a trap that
   unwinds to JS, and the instance's memory may be left half-updated. So the
   harness's wasi build runs a single test per instance (test index in argv[1])
   and the next test starts from a clean copy of the same compiled Module.

   Memory layout (wasm-ld --stack-first, the default): the stack sits at
   [0, STACK_BYTES) growing down, globals and heap above it. Address 0 is
   ordinary memory in wasm, so a NULL *read* can't be caught; but the lowest
   GUARD_BYTES are reserved extra stack that real code never reaches, so a
   NULL *write* (or a stack that just overflowed into it) leaves it non-zero,
   and run() reports that as a crash. Overflowing past 0 traps on its own. */
(function (root) {
  'use strict';

  var MARK = '@@DSA@@'; // = DSA.cHarness.MARK (tools/c_wasm.mjs asserts they match)
  var GUARD_BYTES = 4096;
  var STACK_BYTES = 8 * 1024 * 1024 + GUARD_BYTES; // 8 MB usable, like a native default
  var MAX_MEMORY = 512 * 1024 * 1024;              // malloc returns NULL past this
  var MAX_OUTPUT = 1024 * 1024;                    // stdout+stderr kept per run

  var CLANG_ARGS = [
    '--target=wasm32-wasip1', '-O2', '-std=gnu11', '-fno-color-diagnostics',
    '-Wl,-z,stack-size=' + STACK_BYTES,
    '-Wl,--max-memory=' + MAX_MEMORY
  ];
  var LINK_LIBS = ['-lm'];

  // Same wording as the native harness's dsa_sig_name() in c-harness.js.
  var MSG = {
    segv: 'Segmentation fault (invalid memory access - check NULL pointers and array bounds, or recursion that never ends)',
    nullWrite: 'Segmentation fault (write through a NULL pointer, or the stack overflowed - check NULL pointers, or recursion that never ends)',
    stack: 'Stack overflow (recursion that never ends, or too deep)',
    fpe: 'Floating point exception (integer division by zero?)',
    // Clang turns code it can prove is undefined (often a NULL dereference) into a trap.
    abort: 'Aborted (assert failed or abort() called) - or undefined behavior the compiler trapped, e.g. a NULL pointer dereference',
    timeout: 'Time limit exceeded (took over 2s - infinite loop?)',
    other: 'Program crashed'
  };

  /** Map a trap / JS error thrown out of wasm to a terminal-style message. */
  function crashMessage(err) {
    var m = String((err && err.message) || err || '');
    if (/out of bounds|memory access/i.test(m)) return MSG.segv;
    if (/divi(de|sion) by zero|integer overflow|remainder by zero/i.test(m)) return MSG.fpe;
    if (/unreachable/i.test(m)) return MSG.abort;
    // V8 "Maximum call stack size exceeded", Firefox "too much recursion",
    // Safari "call stack exhausted": the engine's own stack ran out first.
    if (/call stack|too much recursion|stack exhausted/i.test(m)) return MSG.stack;
    if (/out of memory|could not allocate/i.test(m)) return 'Out of memory';
    return MSG.other + (m ? ' (' + m + ')' : '');
  }

  function ExitSignal(code) { this.code = code; }

  var enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  var dec = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

  function concat(chunks) {
    var n = 0, i;
    for (i = 0; i < chunks.length; i++) n += chunks[i].length;
    var out = new Uint8Array(n), off = 0;
    for (i = 0; i < chunks.length; i++) { out.set(chunks[i], off); off += chunks[i].length; }
    return out;
  }

  function nowNs() {
    var ms = (typeof performance !== 'undefined' && performance.timeOrigin)
      ? performance.timeOrigin + performance.now() : Date.now();
    return BigInt(Math.round(ms * 1e6));
  }

  function fillRandom(buf) {
    var c = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto : null;
    for (var off = 0; off < buf.length; off += 65536) {
      var part = buf.subarray(off, Math.min(buf.length, off + 65536));
      if (c) c.getRandomValues(part);
      else for (var i = 0; i < part.length; i++) part[i] = (Math.random() * 256) | 0;
    }
  }

  // errno values from wasi_snapshot_preview1
  var E = { SUCCESS: 0, BADF: 8, INVAL: 28, NOSYS: 52, SPIPE: 70 };

  /**
   * Instantiate `module` (a compiled WebAssembly.Module) and run its _start.
   * opts: { args: string[], stdin: string,
   *         onOutput(fd, bytes)  called with each stdout/stderr write as it
   *                              happens (the run worker streams it, so a
   *                              program killed for running too long still
   *                              shows what it printed) }
   * Returns { stdout, stderr, exitCode, crash } — crash is null, or a message
   * when the program trapped or wrote to the NULL guard zone.
   */
  function run(module, opts) {
    opts = opts || {};
    var args = (opts.args || ['prog']).map(function (a) { return enc.encode(String(a) + '\0'); });
    var stdin = enc.encode(opts.stdin || '');
    var stdinPos = 0;
    var out = [], err = [];
    var kept = 0, truncated = false;
    var onOutput = opts.onOutput;
    var memory = null;

    function u8() { return new Uint8Array(memory.buffer); }
    function dv() { return new DataView(memory.buffer); }

    var wasi = {
      args_sizes_get: function (pArgc, pSize) {
        var d = dv(), size = 0;
        for (var i = 0; i < args.length; i++) size += args[i].length;
        d.setUint32(pArgc, args.length, true);
        d.setUint32(pSize, size, true);
        return E.SUCCESS;
      },
      args_get: function (pArgv, pBuf) {
        var d = dv(), m = u8();
        for (var i = 0; i < args.length; i++) {
          d.setUint32(pArgv + 4 * i, pBuf, true);
          m.set(args[i], pBuf);
          pBuf += args[i].length;
        }
        return E.SUCCESS;
      },
      environ_sizes_get: function (pCount, pSize) {
        var d = dv(); d.setUint32(pCount, 0, true); d.setUint32(pSize, 0, true);
        return E.SUCCESS;
      },
      environ_get: function () { return E.SUCCESS; },
      fd_write: function (fd, iovs, iovsLen, pWritten) {
        if (fd !== 1 && fd !== 2) return E.BADF;
        var d = dv(), m = u8(), total = 0;
        for (var i = 0; i < iovsLen; i++) {
          var ptr = d.getUint32(iovs + 8 * i, true);
          var len = d.getUint32(iovs + 8 * i + 4, true);
          total += len;
          if (!len || truncated) continue;
          var bytes = m.slice(ptr, ptr + Math.min(len, MAX_OUTPUT - kept));
          kept += bytes.length;
          if (kept >= MAX_OUTPUT) truncated = true;
          (fd === 1 ? out : err).push(bytes);
          if (onOutput) onOutput(fd, bytes);
        }
        d.setUint32(pWritten, total, true);
        return E.SUCCESS;
      },
      fd_read: function (fd, iovs, iovsLen, pRead) {
        if (fd !== 0) return E.BADF;
        var d = dv(), m = u8(), total = 0;
        for (var i = 0; i < iovsLen && stdinPos < stdin.length; i++) {
          var ptr = d.getUint32(iovs + 8 * i, true);
          var len = d.getUint32(iovs + 8 * i + 4, true);
          var n = Math.min(len, stdin.length - stdinPos);
          m.set(stdin.subarray(stdinPos, stdinPos + n), ptr);
          stdinPos += n; total += n;
        }
        d.setUint32(pRead, total, true);
        return E.SUCCESS;
      },
      fd_fdstat_get: function (fd, pStat) {
        if (fd > 2) return E.BADF;
        var d = dv();
        d.setUint8(pStat, 2);                  // filetype: character device
        d.setUint16(pStat + 2, 0, true);       // flags
        d.setBigUint64(pStat + 8, 0n, true);   // rights base
        d.setBigUint64(pStat + 16, 0n, true);  // rights inheriting
        return E.SUCCESS;
      },
      fd_seek: function (fd) { return fd > 2 ? E.BADF : E.SPIPE; },
      fd_close: function () { return E.SUCCESS; },
      fd_prestat_get: function () { return E.BADF; }, // no preopened dirs: no filesystem
      fd_prestat_dir_name: function () { return E.BADF; },
      clock_res_get: function (id, pRes) { dv().setBigUint64(pRes, 1000n, true); return E.SUCCESS; },
      clock_time_get: function (id, precision, pTime) { dv().setBigUint64(pTime, nowNs(), true); return E.SUCCESS; },
      random_get: function (ptr, len) { fillRandom(new Uint8Array(memory.buffer, ptr, len)); return E.SUCCESS; },
      sched_yield: function () { return E.SUCCESS; },
      proc_exit: function (code) { throw new ExitSignal(code); }
    };

    // Anything else a program might import (files, sockets, polling) fails
    // cleanly with ENOSYS instead of breaking instantiation.
    var imports = {};
    WebAssembly.Module.imports(module).forEach(function (imp) {
      if (imp.kind !== 'function') return;
      var ns = imports[imp.module] || (imports[imp.module] = {});
      ns[imp.name] = (imp.module === 'wasi_snapshot_preview1' && wasi[imp.name]) ||
        function () { return E.NOSYS; };
    });

    var exitCode = 0, crash = null;
    try {
      var inst = new WebAssembly.Instance(module, imports);
      memory = inst.exports.memory;
      inst.exports._start();
    } catch (e) {
      if (e instanceof ExitSignal) exitCode = e.code;
      else { crash = crashMessage(e); exitCode = 1; }
    }
    if (!crash && memory && guardDirty(memory)) { crash = MSG.nullWrite; exitCode = 1; }

    if (truncated) err.push(enc.encode('\n[output truncated after ' + (MAX_OUTPUT >> 20) + ' MB]\n'));
    return {
      stdout: dec.decode(concat(out)),
      stderr: dec.decode(concat(err)),
      exitCode: exitCode,
      crash: crash
    };
  }

  function guardDirty(memory) {
    var g = new Uint8Array(memory.buffer, 0, GUARD_BYTES);
    for (var i = 0; i < g.length; i++) if (g[i]) return true;
    return false;
  }

  /**
   * stdout for one harness test, in the same shape the native harness
   * prints, so DSA.cHarness.parseOutput() handles both. When the test
   * crashed (or timed out — pass { crash: MSG.timeout }), the program never
   * printed its own marker, so add an ERR one.
   */
  function testOutput(i, res) {
    var s = res.stdout || '';
    if (res.crash) return s + '\n' + MARK + '|' + i + '|ERR|' + res.crash + '\n';
    if (res.exitCode !== 0 && s.indexOf(MARK + '|' + i + '|') < 0) {
      return s + '\n' + MARK + '|' + i + '|ERR|Program exited with code ' + res.exitCode + ' before returning\n';
    }
    return s;
  }

  /** argv for running harness test i. */
  function testArgs(i) { return ['prog', String(i)]; }

  var api = {
    CLANG_ARGS: CLANG_ARGS,
    LINK_LIBS: LINK_LIBS,
    GUARD_BYTES: GUARD_BYTES,
    MARK: MARK,
    MSG: MSG,
    run: run,
    crashMessage: crashMessage,
    testArgs: testArgs,
    testOutput: testOutput
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.DSA = root.DSA || {}; root.DSA.cWasi = api; }
})(typeof self !== 'undefined' ? self : this);
