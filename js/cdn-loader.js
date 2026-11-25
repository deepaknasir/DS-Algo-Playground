/* Shared front-end for the code editor and the Python / C runtimes, used by
   practice.js, code-runner.js, code-block.js and problem-renderer.js:
     - loadCodeMirror / makeEditor — CodeMirror, self-hosted in /vendor/codemirror/
     - runPython / warmup          — Python via a Web Worker (js/pyodide-worker.js),
                                      so a runaway program can be terminated
     - runC / warmupC / loadCHarness — C compiled by Clang-in-WebAssembly in a
                                      compile worker (js/c-compile-worker.js) and run
                                      in a disposable worker (js/c-run-worker.js);
                                      js/c-harness.js wraps solutions in a test main()
     - lang                        — site-wide Python/C preference (localStorage)
     - normalizeIndent / formatPyError — editor + traceback helpers
   Pyodide and the Clang toolchain load from cdn.jsdelivr.net (inside the workers)
   due to size; code never leaves the browser. */
var DSA = window.DSA || {};

(function() {
  'use strict';

  if (DSA.cdnLoader) return; // singleton

  // --- Resolve vendored paths from any depth (root, /topics/, /problems/) ---
  function vendorPath(filename) {
    var p = window.location.pathname;
    var prefix = (p.indexOf('/topics/') !== -1 || p.indexOf('/problems/') !== -1) ? '../' : '';
    return prefix + 'vendor/codemirror/' + filename;
  }

  var CM_CSS    = vendorPath('codemirror.min.css');
  var CM_JS     = vendorPath('codemirror.min.js');
  var CM_PYTHON = vendorPath('python.min.js');
  var CM_CLIKE  = vendorPath('clike.min.js');
  var CM_RUNMODE = vendorPath('runmode.min.js'); // static highlighting (approach code)
  var CM_CLOSE  = vendorPath('closebrackets.min.js');

  // --- Loader primitives ---
  function loadCSS(url) {
    if (document.querySelector('link[href="' + url + '"]')) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = url;
    document.head.appendChild(link);
  }

  function loadScript(url, callback) {
    if (document.querySelector('script[src="' + url + '"]')) {
      if (callback) callback();
      return;
    }
    var s = document.createElement('script');
    s.src = url;
    s.onload = function() { if (callback) callback(); };
    s.onerror = function() { if (callback) callback(new Error('Failed to load: ' + url)); };
    document.head.appendChild(s);
  }

  // --- CodeMirror singleton ---
  var cmLoaded = false;
  var cmLoading = false;
  var cmCallbacks = [];

  function flushCm(err) {
    var cbs = cmCallbacks.slice(); cmCallbacks = [];
    for (var i = 0; i < cbs.length; i++) cbs[i](err);
  }

  function loadCodeMirror(callback) {
    if (window.CodeMirror && cmLoaded) { callback(); return; }
    // CodeMirror core present but this loader didn't finish (or never ran):
    // only short-circuit when the modes we need are already registered too.
    if (window.CodeMirror && !cmLoading && window.CodeMirror.runMode &&
        window.CodeMirror.mimeModes && window.CodeMirror.mimeModes['text/x-csrc']) {
      cmLoaded = true; callback(); return;
    }
    cmCallbacks.push(callback);
    if (cmLoading) return;
    cmLoading = true;
    loadCSS(CM_CSS);
    loadScript(CM_JS, function(err) {
      if (err) { flushCm(err); return; }
      loadScript(CM_PYTHON, function(err2) {
        if (err2) { flushCm(err2); return; }
        loadScript(CM_CLOSE, function(err3) {
          if (err3) { flushCm(err3); return; }
          loadScript(CM_CLIKE, function(err4) {
            if (err4) { flushCm(err4); return; }
            loadScript(CM_RUNMODE, function(err5) {
              cmLoaded = !err5;
              flushCm(err5 || null);
            });
          });
        });
      });
    });
  }

  // --- Editor factory (shared soft-tab config) --------------------------
  // Python is whitespace-sensitive and Pyodide rejects mixed tabs/spaces with
  // TabError. CodeMirror inserts a literal \t on Tab by default, so we force
  // soft tabs (spaces) everywhere the editor is created.
  var INDENT = 4;

  function softTabKeys() {
    return {
      Tab: function(cm) {
        if (cm.somethingSelected()) { cm.indentSelection('add'); return; }
        var unit = cm.getOption('indentUnit') || INDENT;
        cm.replaceSelection(new Array(unit + 1).join(' '), 'end', '+input');
      },
      'Shift-Tab': function(cm) { cm.indentSelection('subtract'); },
      Backspace: function(cm) {
        if (cm.somethingSelected()) return window.CodeMirror.Pass;
        var cur = cm.getCursor();
        var before = cm.getLine(cur.line).slice(0, cur.ch);
        if (before.length && /^ +$/.test(before)) {
          var unit = cm.getOption('indentUnit') || INDENT;
          var del = before.length % unit || unit;
          cm.replaceRange('', { line: cur.line, ch: cur.ch - del }, cur, '+delete');
          return;
        }
        return window.CodeMirror.Pass;
      }
    };
  }

  // lang: 'python' (default) or 'c'
  function makeEditor(parent, value, lang) {
    return window.CodeMirror(parent, {
      value: value || '',
      mode: cmMode(lang),
      theme: 'dracula',
      lineNumbers: true,
      indentUnit: INDENT,
      indentWithTabs: false,
      autoCloseBrackets: true,
      lineWrapping: false,
      viewportMargin: Infinity,
      extraKeys: softTabKeys()
    });
  }

  function cmMode(lang) { return lang === 'c' ? 'text/x-csrc' : 'python'; }

  // Switch an existing editor between languages (C uses the same soft tabs).
  function setEditorLang(cm, lang) { cm.setOption('mode', cmMode(lang)); }

  // Convert leading tabs to spaces (per line) so drafts saved before the
  // soft-tab fix, or pasted tab-indented code, run without TabError. Only
  // touches leading whitespace — tabs inside string literals are left alone.
  function normalizeIndent(code) {
    if (!code) return code;
    return String(code).split('\n').map(function(line) {
      var m = line.match(/^[ \t]+/);
      if (!m) return line;
      return m[0].replace(/\t/g, '    ') + line.slice(m[0].length);
    }).join('\n');
  }

  // Strip Pyodide/harness-internal frames from a traceback so the user sees
  // only their own code's frames + the final error, like a real interpreter.
  function formatPyError(raw) {
    if (!raw) return raw;
    var lines = String(raw).replace(/^PythonError:\s*/, '').split('\n');
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      var fm = ln.match(/^\s*File "([^"]*)"/);
      if (fm) {
        var isUser = fm[1] === '<your code>';
        var hasSrc = i + 1 < lines.length && /^\s/.test(lines[i + 1]) && !/^\s*File "/.test(lines[i + 1]);
        if (isUser) {
          out.push(ln);
          if (hasSrc) out.push(lines[++i]);
        } else if (hasSrc) {
          i++; // drop internal frame's source line too
        }
        continue;
      }
      out.push(ln);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // --- Pyodide Web Worker (off-main-thread execution + kill switch) ------
  // Static hosting (GitHub Pages) can't send COOP/COEP headers, so Pyodide's
  // SharedArrayBuffer interrupt isn't available. Running in a Worker lets us
  // terminate() a runaway/infinite-loop program and respawn a fresh runtime.
  function scriptPath(filename) {
    var p = window.location.pathname;
    var prefix = (p.indexOf('/topics/') !== -1 || p.indexOf('/problems/') !== -1) ? '../' : '';
    return prefix + 'js/' + filename;
  }

  var worker = null;
  var reqId = 0;
  var pending = {}; // id -> { cb, timer }
  var warmed = false; // whether a warmup message has pre-loaded the current worker

  function spawnWorker() {
    worker = new Worker(scriptPath('pyodide-worker.js'));
    worker.onmessage = function(e) {
      var d = e.data || {};
      var entry = pending[d.id];
      if (!entry) return;
      clearTimeout(entry.timer);
      delete pending[d.id];
      entry.cb(d);
    };
    worker.onerror = function(err) {
      var msg = (err && err.message) || 'Worker failed to start';
      killWorker(); // dead worker — force a fresh spawn on the next run
      rejectAll({ error: msg });
    };
  }

  function killWorker() {
    if (worker) { try { worker.terminate(); } catch (e) {} }
    worker = null;
    warmed = false; // respawned worker starts cold; allow a fresh warmup
  }

  function rejectAll(data) {
    var snapshot = pending;
    pending = {};
    for (var id in snapshot) {
      if (snapshot.hasOwnProperty(id)) {
        clearTimeout(snapshot[id].timer);
        snapshot[id].cb(Object.assign({ id: +id }, data));
      }
    }
  }

  // Run a payload in the worker with a timeout. On timeout, terminate the
  // wedged worker and respawn. cb gets the worker's data object, or
  // { timeout: true }, or { error: ... }.
  //
  // NOTE: there is a single shared worker, so runs are serialized. The Python
  // interpreter is single-threaded — an infinite loop in one run blocks any
  // other run queued behind it, so on timeout we terminate the whole worker
  // and every in-flight request resolves as timed out. In practice each page
  // has one active editor and users run one at a time, so this is fine; if
  // simultaneous multi-editor execution ever matters, give each a own worker.
  function runPython(payload, timeoutMs, cb) {
    if (!worker) spawnWorker();
    var id = ++reqId;
    payload.id = id;
    var timer = setTimeout(function() {
      if (!pending[id]) return;
      // Hand this request its timeout, then kill the wedged worker and time
      // out every stranded sibling too (they're stuck behind the same loop).
      delete pending[id];
      killWorker();
      rejectAll({ timeout: true });
      cb({ id: id, timeout: true });
    }, timeoutMs);
    pending[id] = { cb: cb, timer: timer };
    worker.postMessage(payload);
  }

  // Pre-load Pyodide in the worker so the first Run isn't a cold start. Safe to
  // call from every editor's init — the actual load happens once in the worker,
  // and this guard avoids redundant warmup messages on multi-block pages.
  function warmup() {
    if (warmed) return;
    warmed = true;
    runPython({ mode: 'warmup' }, 60000, function() {});
  }

  // --- Language preference (Python / C), shared by every switcher -------
  // Stored per browser; every code block, trace panel, approach and practice
  // editor on the page follows it. Fires 'dsa:code-lang' when it changes.
  var LANG_KEY = 'dsa-code-lang';
  var LANGS = { python: 'Python', c: 'C' };
  var lang = {
    LABELS: LANGS,
    get: function() {
      try { var v = localStorage.getItem(LANG_KEY); if (LANGS[v]) return v; } catch (e) {}
      return 'python';
    },
    set: function(v) {
      if (!LANGS[v]) return;
      try { localStorage.setItem(LANG_KEY, v); } catch (e) {}
      try { window.dispatchEvent(new CustomEvent('dsa:code-lang', { detail: { lang: v } })); } catch (e) {}
    },
    onChange: function(fn) {
      window.addEventListener('dsa:code-lang', function(e) { fn(e.detail && e.detail.lang); });
    },
    /** A small Python | C segmented switch. available: array of langs to offer. */
    makeSwitch: function(available, current, onPick) {
      var wrap = document.createElement('div');
      wrap.className = 'lang-switch';
      wrap.setAttribute('role', 'group');
      wrap.setAttribute('aria-label', 'Code language');
      (available || ['python', 'c']).forEach(function(l) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'lang-switch__btn' + (l === current ? ' lang-switch__btn--active' : '');
        b.setAttribute('data-lang', l);
        b.setAttribute('aria-pressed', l === current ? 'true' : 'false');
        b.textContent = LANGS[l] || l;
        b.addEventListener('click', function() { onPick(l); });
        wrap.appendChild(b);
      });
      wrap.setActive = function(l) {
        var btns = wrap.querySelectorAll('.lang-switch__btn');
        for (var i = 0; i < btns.length; i++) {
          var on = btns[i].getAttribute('data-lang') === l;
          btns[i].classList.toggle('lang-switch__btn--active', on);
          btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
        }
      };
      return wrap;
    }
  };

  // --- C, compiled and run in the browser (WebAssembly) ------------------
  // Clang built for WebAssembly compiles the program to wasm32-wasi in a
  // long-lived compile worker (js/c-compile-worker.js; the toolchain comes
  // from jsDelivr once, then the browser cache). The program then runs in a
  // disposable run worker (js/c-run-worker.js) through the WASI shim in
  // js/c-wasi.js. Nothing is sent to a server, and it works offline once
  // cached. Two workers, so killing a runaway program (wasm can't be
  // interrupted from inside) doesn't also throw away the loaded compiler.
  var C_COMPILE_TIMEOUT_MS = 180000; // includes the first-time toolchain download
  var C_TEST_TIMEOUT_MS = 2000;      // per harness test, like the native alarm(2)
  var C_RUN_TIMEOUT_MS = 10000;      // a plain program (code blocks)

  var cc = null;          // compile worker
  var ccId = 0;
  var ccPending = {};     // id -> { cb, timer, onStatus }
  var cWarmed = false;

  function ccSpawn() {
    cc = new Worker(scriptPath('c-compile-worker.js'));
    cc.onmessage = function(e) {
      var d = e.data || {};
      if (d.progress) {
        var pct = d.progress.total ? Math.floor(100 * d.progress.done / d.progress.total) : 0;
        var msg = 'Loading the C compiler… ' + pct + '%'; // ~23 MB on the first run, then from cache
        for (var k in ccPending) if (ccPending[k].onStatus) ccPending[k].onStatus(msg);
        return;
      }
      var entry = ccPending[d.id];
      if (!entry) return;
      clearTimeout(entry.timer);
      delete ccPending[d.id];
      entry.cb(d);
    };
    cc.onerror = function(err) {
      var msg = (err && err.message) || 'The C compiler worker failed to start';
      ccKill();
      ccRejectAll({ error: msg });
    };
  }

  function ccKill() {
    if (cc) { try { cc.terminate(); } catch (e) {} }
    cc = null;
    cWarmed = false;
  }

  function ccRejectAll(data) {
    var snapshot = ccPending; ccPending = {};
    for (var id in snapshot) {
      if (snapshot.hasOwnProperty(id)) { clearTimeout(snapshot[id].timer); snapshot[id].cb(data); }
    }
  }

  function ccRequest(payload, onStatus, cb) {
    if (!cc) ccSpawn();
    var id = ++ccId;
    payload.id = id;
    var timer = setTimeout(function() {
      if (!ccPending[id]) return;
      ccKill();             // a wedged download or compile: start over next time
      ccRejectAll({ timeout: true });
    }, C_COMPILE_TIMEOUT_MS);
    ccPending[id] = { cb: cb, timer: timer, onStatus: onStatus };
    cc.postMessage(payload);
  }

  // Start downloading Clang in the background once the user is working in C,
  // so the first Run doesn't wait for it. Safe to call often.
  function warmupC() {
    if (cWarmed) return;
    cWarmed = true;
    ccRequest({ mode: 'warmup' }, null, function() {});
  }

  function loadCWasi(cb) {
    if (DSA.cWasi) { cb(); return; }
    loadScript(scriptPath('c-wasi.js'), function(err) { cb(err || (DSA.cWasi ? null : new Error('c-wasi.js missing'))); });
  }

  // Run a harness program's tests 0..n-1, each in a fresh instance, with a
  // per-test time limit: on timeout, kill the run worker, give that test the
  // time-limit error (plus whatever it printed) and resume after it.
  function runCTests(wasm, n, cb) {
    var W = DSA.cWasi;
    var outs = [];
    var next = 0;
    function step() {
      if (next >= n) { cb(outs.join('')); return; }
      var w = new Worker(scriptPath('c-run-worker.js'));
      var partial = '';
      var timer = null;
      function arm() { clearTimeout(timer); timer = setTimeout(onTimeout, C_TEST_TIMEOUT_MS); }
      function stop() { clearTimeout(timer); w.onmessage = w.onerror = null; w.terminate(); }
      function onTimeout() {
        stop();
        outs[next] = W.testOutput(next, { stdout: partial, crash: W.MSG.timeout });
        next++; step();
      }
      w.onmessage = function(e) {
        var d = e.data || {};
        if (d.out) { if (d.out.fd === 1) partial += d.out.text; return; }
        if (d.start !== undefined) { partial = ''; arm(); return; }
        outs[d.i] = W.testOutput(d.i, d.res);
        next = d.i + 1;
        if (next >= n) { stop(); cb(outs.join('')); }
      };
      w.onerror = function(err) {
        if (err && err.preventDefault) err.preventDefault();
        stop();
        outs[next] = W.testOutput(next, { stdout: partial, crash: W.crashMessage(err) });
        next++; step();
      };
      arm(); // also covers instantiating the module before the first test starts
      var copy = wasm.slice(0);
      w.postMessage({ mode: 'tests', wasm: copy, from: next, n: n }, [copy]);
    }
    step();
  }

  // Run a plain program (main) once, with an overall time limit.
  function runCPlain(wasm, stdin, timeoutMs, cb) {
    var w = new Worker(scriptPath('c-run-worker.js'));
    var out = '', err = '';
    var timer = setTimeout(function() {
      w.terminate();
      cb({ stdout: out, stderr: err, exitCode: null, crash: null, timedOut: true });
    }, timeoutMs);
    w.onmessage = function(e) {
      var d = e.data || {};
      if (d.out) { if (d.out.fd === 1) out += d.out.text; else err += d.out.text; return; }
      if (d.plain) { clearTimeout(timer); w.terminate(); cb(d.plain); }
    };
    w.onerror = function(e) {
      if (e && e.preventDefault) e.preventDefault();
      clearTimeout(timer); w.terminate();
      cb({ stdout: out, stderr: err, exitCode: 1, crash: DSA.cWasi.crashMessage(e) });
    };
    var copy = wasm.slice(0);
    w.postMessage({ mode: 'plain', wasm: copy, stdin: stdin || '' }, [copy]);
  }

  /**
   * Compile + run C source in the browser. opts:
   *   tests: n         source is a c-harness.js program with n tests; its
   *                    stdout comes back in the format parseOutput() reads
   *   stdin, timeoutMs (plain programs; default 10s)
   *   onStatus(msg)    progress text while the compiler downloads
   * cb receives:
   *   { ok: true, stdout, stderr, exitCode, crash, timedOut, compileOutput } — it ran
   *   { compileError: '...' }                                     — didn't compile
   *   { timeout: true } | { error: '...' }                        — compiler didn't load
   */
  function runC(source, opts, cb) {
    opts = opts || {};
    loadCWasi(function(err) {
      if (err) { cb({ error: String(err.message || err) }); return; }
      if (typeof WebAssembly !== 'object') { cb({ error: 'This browser does not support WebAssembly.' }); return; }
      cWarmed = true; // this request downloads the toolchain if a warmup didn't
      ccRequest({ mode: 'compile', source: source }, opts.onStatus, function(d) {
        if (d.timeout || d.error) { cb(d.timeout ? { timeout: true } : { error: d.error }); return; }
        if (d.compileError !== undefined) { cb({ compileError: d.compileError }); return; }
        if (opts.onStatus) opts.onStatus('Running…');
        var compileOutput = d.diagnostics || '';
        if (typeof opts.tests === 'number') {
          runCTests(d.wasm, opts.tests, function(stdout) {
            cb({ ok: true, stdout: stdout, stderr: '', exitCode: 0, crash: null, timedOut: false, compileOutput: compileOutput });
          });
        } else {
          runCPlain(d.wasm, opts.stdin, opts.timeoutMs || C_RUN_TIMEOUT_MS, function(r) {
            cb({ ok: true, stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, crash: r.crash,
                 timedOut: !!r.timedOut, compileOutput: compileOutput });
          });
        }
      });
    });
  }

  // Describe a non-zero exit like a terminal would.
  function describeExit(code) {
    if (code === 0 || code === undefined || code === null) return '';
    var sig = { 139: 'Segmentation fault', 136: 'Floating point exception', 134: 'Aborted', 137: 'Killed (time or memory limit)', 135: 'Bus error', 132: 'Illegal instruction (undefined behavior, e.g. division by zero)', 133: 'Trace/breakpoint trap' };
    if (sig[code]) return sig[code] + ' (exit code ' + code + ')';
    if (code < 0) return 'Program terminated (exit code ' + code + ')';
    return 'Exited with code ' + code;
  }

  // Tidy compiler diagnostics (see DSA.cHarness.formatCompileErrors).
  function formatCError(raw) {
    if (DSA.cHarness) return DSA.cHarness.formatCompileErrors(raw);
    return String(raw || '').trim();
  }

  function loadCHarness(cb) {
    if (DSA.cHarness) { cb(); return; }
    loadScript(scriptPath('c-harness.js'), function(err) { cb(err || (DSA.cHarness ? null : new Error('c-harness missing'))); });
  }

  DSA.cdnLoader = {
    loadCodeMirror: loadCodeMirror,
    makeEditor: makeEditor,
    setEditorLang: setEditorLang,
    lang: lang,
    runC: runC,
    warmupC: warmupC,
    describeExit: describeExit,
    formatCError: formatCError,
    loadCHarness: loadCHarness,
    softTabKeys: softTabKeys,
    normalizeIndent: normalizeIndent,
    formatPyError: formatPyError,
    runPython: runPython,
    warmup: warmup,
    INDENT: INDENT
  };
})();
