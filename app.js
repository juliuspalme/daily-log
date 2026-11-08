/* Daily Log — UI, GitHub storage and sync.
 *
 * The whole log is one file in a GitHub repo, encrypted by crypto.js before
 * it is committed. The only network calls this app makes are to
 * api.github.com. Data model and merge rules live in model.js.
 */
(function () {
  "use strict";

  var C = window.AppCrypto, M = window.AppModel;

  var INTERVAL_MS = 90000;   // timed gap between readings
  var POLL_MS = 60000;
  var N = M.READINGS;

  var app = document.getElementById("app");
  var nav = document.getElementById("nav");
  var gear = document.getElementById("gear");
  var statusEl = document.getElementById("status");
  var statusText = document.getElementById("status-text");

  /* ------------------------------------------------------------------ *
   * device storage
   * ------------------------------------------------------------------ */
  var LS = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} },
    json: function (k, dflt) {
      try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : dflt; }
      catch (e) { return dflt; }
    }
  };

  function guessRepo() {
    var m = location.hostname.match(/^([A-Za-z0-9-]+)\.github\.io$/i);
    if (!m) return { owner: "", repo: "" };
    var seg = location.pathname.split("/").filter(Boolean)[0];
    return { owner: m[1], repo: seg || (m[1] + ".github.io") };
  }
  function cfg() {
    var saved = LS.json("dl.cfg", null);
    if (saved && saved.owner && saved.repo) return saved;
    var g = guessRepo();
    return { owner: g.owner, repo: g.repo, branch: "main", path: "data/log.enc.json" };
  }
  function saveCfg(c) { LS.set("dl.cfg", JSON.stringify(c)); }
  function token() { return LS.get("dl.token") || ""; }
  function passphrase() { return LS.get("dl.pass") || ""; }
  function connected() { var c = cfg(); return !!(c.owner && c.repo && token() && passphrase()); }

  /* ------------------------------------------------------------------ *
   * GitHub contents API
   * ------------------------------------------------------------------ */
  function apiUrl(c, withRef) {
    var u = "https://api.github.com/repos/" + encodeURIComponent(c.owner) + "/" +
            encodeURIComponent(c.repo) + "/contents/" +
            c.path.split("/").map(encodeURIComponent).join("/");
    return withRef ? u + "?ref=" + encodeURIComponent(c.branch) : u;
  }

  async function ghFetch(url, opts) {
    opts = opts || {};
    var headers = { "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    if (token()) headers.Authorization = "Bearer " + token();
    if (opts.body) headers["Content-Type"] = "application/json";
    try {
      return await fetch(url, { method: opts.method || "GET", headers: headers, body: opts.body, cache: "no-store" });
    } catch (e) {
      throw { kind: "net", message: "No connection to GitHub." };
    }
  }

  async function ghError(res, verb) {
    var body = null;
    try { body = await res.json(); } catch (e) {}
    var msg = (body && body.message) || res.statusText || ("HTTP " + res.status);
    var c = cfg();
    if (res.status === 401) return { kind: "auth", message: "GitHub rejected the token. It may have expired — paste a new one in Settings." };
    if (res.status === 403 && /rate limit/i.test(msg)) return { kind: "rate", message: "GitHub rate limit reached. It resets within the hour." };
    if (res.status === 403) return { kind: "auth", message: "The token is not allowed to " + verb + " this repository. It needs Contents: Read and write." };
    if (res.status === 404) return { kind: "missing", message: "Could not find " + c.owner + "/" + c.repo + " — check the names and that the token can see it." };
    if (res.status === 409 || res.status === 422) return { kind: "conflict", message: "Someone else saved first." };
    return { kind: "http", message: "GitHub said: " + msg };
  }

  async function getRemote() {
    var c = cfg();
    var res = await ghFetch(apiUrl(c, true));
    if (res.status === 404) return { parsed: null, sha: null };
    if (!res.ok) throw await ghError(res, "read");
    var j = await res.json();
    var text = j.encoding === "base64" ? C.b64ToStr(j.content) : j.content;
    try { return { parsed: JSON.parse(text), sha: j.sha }; }
    catch (e) { throw { kind: "format", message: "The data file in the repo is not readable JSON." }; }
  }

  async function putRemote(text, sha) {
    var c = cfg();
    var body = { message: "Update log", content: C.strToB64(text), branch: c.branch };
    if (sha) body.sha = sha;
    var res = await ghFetch(apiUrl(c, false), { method: "PUT", body: JSON.stringify(body) });
    if (!res.ok) throw await ghError(res, "write to");
    return res.json();
  }

  /* ------------------------------------------------------------------ *
   * app state
   * ------------------------------------------------------------------ */
  var S = {
    base: LS.json("dl.state", null) || M.emptyState(),
    queue: LS.json("dl.queue", []),
    loaded: !!LS.json("dl.state", null),
    view: "log",
    metric: "total",
    me: LS.get("dl.me"),
    run: LS.json("dl.run", null),
    summary: null,
    armed: null,
    busy: false,
    formError: null,
    wakeLock: null
  };
  var SY = { busy: false, again: false, err: null, lastSync: 0 };

  function saveQueue() { LS.set("dl.queue", JSON.stringify(S.queue)); }
  function setBase(st) { S.base = st; S.loaded = true; LS.set("dl.state", JSON.stringify(st)); }
  function pushOp(op) {
    op.oid = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    S.queue.push(op); saveQueue();
  }
  function dropOps(oids) {
    S.queue = S.queue.filter(function (o) { return oids.indexOf(o.oid) < 0; });
    saveQueue();
  }
  /** What the screen shows: the last synced state plus anything still queued. */
  function V() { return M.applyOps(M.clone(S.base || M.emptyState()), S.queue); }
  function isPending(id) {
    return S.queue.some(function (o) { return o.op === "add" && o.entry.id === id; });
  }

  /* ------------------------------------------------------------------ *
   * sync
   * ------------------------------------------------------------------ */
  async function sync() {
    if (!connected()) { renderStatus(); return; }
    if (SY.busy) { SY.again = true; return; }
    SY.busy = true; renderStatus();
    try {
      for (var tries = 1; ; tries++) {
        var remote = await getRemote();
        var kdf = remote.parsed ? remote.parsed.kdf : null;
        var st = remote.parsed ? await C.decryptFile(remote.parsed, passphrase()) : M.emptyState();
        var q = S.queue.slice();
        if (q.length) {
          M.applyOps(st, q);
          st.rev = (st.rev || 0) + 1;
          st.updatedAt = new Date().toISOString();
          try {
            await putRemote(await C.encryptState(st, passphrase(), kdf), remote.sha);
          } catch (e) {
            if (e.kind === "conflict" && tries < 4) continue;
            throw e;
          }
          dropOps(q.map(function (o) { return o.oid; }));
        }
        setBase(st);
        SY.lastSync = Date.now(); SY.err = null;
        break;
      }
    } catch (e) {
      SY.err = e && e.message ? e : { kind: "unknown", message: "Something went wrong talking to GitHub." };
    }
    SY.busy = false;
    render();
    if (SY.again) { SY.again = false; sync(); }
  }

  function ago(ts) {
    var s = Math.round((Date.now() - ts) / 1000);
    if (s < 45) return "just now";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }
  function renderStatus() {
    var cls, txt;
    if (!connected()) { cls = "status bad"; txt = "Not connected"; }
    else if (SY.busy) { cls = "status work"; txt = "Syncing"; }
    else if (SY.err) { cls = "status bad"; txt = SY.err.kind === "net" ? "Offline" : "Sync failed"; }
    else if (S.queue.length) { cls = "status work"; txt = S.queue.length + " unsaved"; }
    else if (SY.lastSync) { cls = "status ok"; txt = "Saved " + ago(SY.lastSync); }
    else { cls = "status ok"; txt = "Ready"; }
    statusEl.className = cls;
    statusText.textContent = txt;
    var btn = statusEl.querySelector("button");
    if (btn) btn.remove();
    if (connected() && !SY.busy) {
      var b = document.createElement("button");
      b.type = "button"; b.textContent = "Refresh"; b.dataset.act = "sync";
      statusEl.appendChild(b);
    }
  }

  /* ------------------------------------------------------------------ *
   * helpers
   * ------------------------------------------------------------------ */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function colorOf(st, id) { var p = M.person(st, id); return p && p.slot === 2 ? "var(--a2)" : "var(--a1)"; }
  function nameOf(st, id) { var p = M.person(st, id); return p ? p.name : "Unknown"; }
  function lastFor(st, id) { var l = M.forPerson(st, id); return l.length ? l[0] : null; }

  function fmtDate(ts) {
    var d = new Date(ts), now = new Date();
    if (d.toDateString() === now.toDateString()) return "Today";
    var y = new Date(now.getTime() - 86400000);
    if (d.toDateString() === y.toDateString()) return "Yesterday";
    var opt = d.getFullYear() === now.getFullYear()
      ? { day: "numeric", month: "short" }
      : { day: "numeric", month: "short", year: "numeric" };
    return d.toLocaleDateString(undefined, opt);
  }
  function buzz() { try { if (navigator.vibrate) navigator.vibrate([420, 140, 420]); } catch (e) {} }
  function persistRun() { if (S.run) LS.set("dl.run", JSON.stringify(S.run)); else LS.del("dl.run"); }

  async function holdScreen(on) {
    try {
      if (on && !S.wakeLock && navigator.wakeLock) {
        S.wakeLock = await navigator.wakeLock.request("screen");
        S.wakeLock.addEventListener("release", function () { S.wakeLock = null; });
      } else if (!on && S.wakeLock) {
        await S.wakeLock.release(); S.wakeLock = null;
      }
    } catch (e) { S.wakeLock = null; }
  }

  /* ------------------------------------------------------------------ *
   * chart
   * ------------------------------------------------------------------ */
  function chart(st) {
    var W = 680, H = 300, PL = 40, PR = 16, PT = 18, PB = 34;
    var series = [], all = [];
    st.people.forEach(function (p) {
      var pts = M.chronological(st, p.id).map(function (e) {
        return { t: e.ts, v: S.metric === "best" ? e.best : e.total };
      });
      if (pts.length) series.push({ color: p.slot === 2 ? "var(--a2)" : "var(--a1)", pts: pts });
      all = all.concat(pts);
    });
    if (!all.length) return "";
    var t0 = Math.min.apply(null, all.map(function (p) { return p.t; }));
    var t1 = Math.max.apply(null, all.map(function (p) { return p.t; }));
    if (t1 - t0 < 86400000) { t0 -= 43200000; t1 += 43200000; }
    var vmax = Math.max.apply(null, all.map(function (p) { return p.v; }));
    var top = Math.max(5, Math.ceil(vmax * 1.18 / 5) * 5);
    var x = function (t) { return PL + (t - t0) / (t1 - t0) * (W - PL - PR); };
    var y = function (v) { return PT + (1 - v / top) * (H - PT - PB); };

    var o = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Readings over time">';
    [0, Math.round(top / 2), top].forEach(function (v) {
      o += '<line x1="' + PL + '" y1="' + y(v).toFixed(1) + '" x2="' + (W - PR) + '" y2="' + y(v).toFixed(1) + '" stroke="var(--line)" stroke-width="1"/>' +
           '<text x="' + (PL - 8) + '" y="' + (y(v) + 4).toFixed(1) + '" text-anchor="end" fill="var(--muted)" font-size="13" font-family="Barlow Condensed, sans-serif">' + v + "</text>";
    });
    [t0, t1].forEach(function (t, i) {
      o += '<text x="' + (i ? W - PR : PL) + '" y="' + (H - 10) + '" text-anchor="' + (i ? "end" : "start") + '" fill="var(--muted)" font-size="13" font-family="Barlow Condensed, sans-serif">' + esc(fmtDate(t)) + "</text>";
    });
    series.forEach(function (s) {
      if (s.pts.length > 1) {
        var d = s.pts.map(function (p, i) { return (i ? "L" : "M") + x(p.t).toFixed(1) + " " + y(p.v).toFixed(1); }).join(" ");
        o += '<path d="' + d + '" fill="none" stroke="' + s.color + '" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>';
      }
      s.pts.forEach(function (p, i) {
        var last = i === s.pts.length - 1;
        o += '<circle cx="' + x(p.t).toFixed(1) + '" cy="' + y(p.v).toFixed(1) + '" r="' + (last ? 5.5 : 3.5) + '" fill="' + (last ? s.color : "var(--surface)") + '" stroke="' + s.color + '" stroke-width="2.5"/>';
      });
      var lp = s.pts[s.pts.length - 1];
      o += '<text x="' + Math.min(W - PR, x(lp.t) + 10).toFixed(1) + '" y="' + (y(lp.v) - 11).toFixed(1) + '" text-anchor="end" fill="' + s.color + '" font-size="15" font-weight="600" font-family="Barlow Condensed, sans-serif">' + lp.v + "</text>";
    });
    return o + "</svg>";
  }

  /* ------------------------------------------------------------------ *
   * views
   * ------------------------------------------------------------------ */
  function vConnect() {
    var c = cfg();
    return '<section class="card">' +
      '<div class="eyebrow">Connect this device</div>' +
      '<h2 style="font-size:27px;margin-top:4px">Point the app at your log</h2>' +
      '<p class="lede" style="margin-top:6px">Entries live as an encrypted file in a GitHub repo. This device needs a token to reach the repo and the passphrase to read the file. Both stay in this browser.</p>' +
      '<form class="form" id="connect">' +
        '<div class="row">' +
          '<div class="field"><label for="f-owner">GitHub user</label><input id="f-owner" value="' + esc(c.owner) + '" autocapitalize="off" autocorrect="off" spellcheck="false" required></div>' +
          '<div class="field"><label for="f-repo">Repository</label><input id="f-repo" value="' + esc(c.repo) + '" autocapitalize="off" autocorrect="off" spellcheck="false" required></div>' +
        "</div>" +
        '<div class="field"><label for="f-token">Access token</label>' +
          '<input id="f-token" type="password" value="' + esc(token()) + '" autocomplete="off" autocapitalize="off" spellcheck="false" required>' +
          '<span class="hint">A fine-grained token with <strong>Contents: Read and write</strong> on this one repo. ' +
          '<a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Create one</a>.</span></div>' +
        '<div class="field"><label for="f-pass">Shared passphrase</label>' +
          '<input id="f-pass" type="password" value="' + esc(passphrase()) + '" autocomplete="off" autocapitalize="off" spellcheck="false" required>' +
          '<span class="hint">The same words on every device. This is the only thing keeping the file private in a public repo — make it long.</span></div>' +
        '<button class="btn" type="submit"' + (S.busy ? " disabled" : "") + ">" + (S.busy ? "Checking…" : "Connect") + "</button>" +
      "</form>" +
      (S.formError ? '<p class="note warn" style="margin-top:11px">' + esc(S.formError) + "</p>" : "") +
    "</section>";
  }

  function vSetupPeople() {
    return '<section class="card">' +
      '<div class="eyebrow">Empty log</div>' +
      '<h2 style="font-size:27px;margin-top:4px">Who is logging?</h2>' +
      '<p class="lede" style="margin-top:6px">Two names, written into the encrypted file. You only do this once, on whichever device gets there first.</p>' +
      '<form class="form" id="people">' +
        '<div class="field"><label for="n1">Person one</label><input id="n1" maxlength="24" autocomplete="off" required></div>' +
        '<div class="field"><label for="n2">Person two</label><input id="n2" maxlength="24" autocomplete="off" required></div>' +
        '<button class="btn" type="submit">Create the log</button>' +
      "</form></section>";
  }

  function vPick(st) {
    var w = M.words(st);
    var cards = st.people.map(function (p) {
      var last = lastFor(st, p.id);
      var sub = last ? last.total + " " + w.unit + " · " + fmtDate(last.ts) : "Nothing logged yet";
      var col = p.slot === 2 ? "var(--a2)" : "var(--a1)";
      return '<button type="button" class="chip" data-act="pick" data-id="' + esc(p.id) + '" aria-pressed="' + (S.me === p.id) + '" style="color:' + col + ";--mark:" + col + '">' +
        '<span class="nm" style="color:var(--fg)">' + esc(p.name) + "</span>" +
        '<span class="sub"><span class="dot"></span> ' + esc(sub) + "</span></button>";
    }).join("");
    return '<section class="card">' +
      '<div class="eyebrow">' + esc(w.activity || "New entry") + "</div>" +
      '<h2 style="font-size:27px;margin-top:4px;margin-bottom:14px">Who is logging?</h2>' +
      '<div class="who">' + cards + "</div>" +
      '<p class="note" style="margin-top:14px">' + N + " readings, 90 seconds apart. The timer starts itself when you save one.</p>" +
    "</section>";
  }

  function vRun(st) {
    var w = M.words(st);
    var r = S.run, n = r.values.length, waiting = r.nextAt && r.nextAt > Date.now();
    var col = colorOf(st, r.personId);
    var slots = "";
    for (var i = 0; i < N; i++) {
      var cls = i < n ? "done" : (i === n && !waiting ? "now" : "");
      slots += '<div class="slot ' + cls + '" style="' + (i < n ? "color:" + col : "") + '"><div class="k">' + esc(w.round) + " " + (i + 1) + '</div><div class="v">' + (i < n ? r.values[i] : "—") + "</div></div>";
    }
    var head = '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
      '<div class="eyebrow" style="color:' + col + '">' + esc(nameOf(st, r.personId)) + "</div>" +
      '<button type="button" class="x" data-act="cancel" style="margin-left:auto">Cancel</button></div>';

    if (waiting) {
      var left = Math.max(0, Math.ceil((r.nextAt - Date.now()) / 1000));
      var frac = Math.max(0, Math.min(1, (r.nextAt - Date.now()) / INTERVAL_MS));
      var circ = 2 * Math.PI * 82;
      return '<section class="card">' + head +
        '<div class="timer"><div class="ringwrap"><svg viewBox="0 0 188 188">' +
          '<circle cx="94" cy="94" r="82" fill="none" stroke="var(--ring)" stroke-width="11"/>' +
          '<circle id="ringarc" cx="94" cy="94" r="82" fill="none" stroke="' + col + '" stroke-width="11" stroke-linecap="round" stroke-dasharray="' + circ.toFixed(1) + '" stroke-dashoffset="' + ((1 - frac) * circ).toFixed(1) + '"/>' +
        "</svg>" +
        '<div class="ringtxt" id="ringtxt"><div class="big">' + left + '</div><div class="cap">seconds</div></div></div>' +
        '<p class="note">' + esc(w.round) + " " + (n + 1) + " of " + N + " unlocks at zero. Your phone buzzes when it does.</p></div>" +
        '<div class="readings" style="margin-top:6px">' + slots + "</div></section>";
    }

    var prev = lastFor(st, r.personId);
    var seed = prev && prev.values[n] != null ? prev.values[n] : (n > 0 ? Math.max(1, r.values[n - 1] - 1) : 8);
    return '<section class="card">' + head +
      '<h2 style="font-size:27px;margin-top:4px">' + esc(w.round) + " " + (n + 1) + " of " + N + (w.activity ? " — " + esc(w.activity) : "") + "</h2>" +
      '<div class="counter">' +
        '<button type="button" class="step" data-act="dec" aria-label="One fewer">−</button>' +
        '<input id="reading" type="number" inputmode="numeric" min="0" max="200" step="1" value="' + seed + '" aria-label="Reading">' +
        '<button type="button" class="step" data-act="inc" aria-label="One more">+</button>' +
      "</div>" +
      '<p class="note" style="text-align:center;margin-bottom:16px">' + esc(w.unit) + "</p>" +
      '<button type="button" class="btn" data-act="save" style="background:' + col + '">' +
        (n < N - 1 ? "Save &amp; start timer" : "Save &amp; finish") + "</button>" +
      '<div class="readings" style="margin-top:16px">' + slots + "</div></section>";
  }

  function vSummary(st) {
    var w = M.words(st);
    var s = S.summary, col = colorOf(st, s.personId);
    var diff = s.prev ? s.total - s.prev.total : null;
    var line = s.prev
      ? (diff > 0 ? "+" + diff + " on last time" : diff < 0 ? diff + " on last time" : "Level with last time")
      : "First entry logged";
    return '<section class="card" style="border-color:' + col + '">' +
      '<div class="eyebrow" style="color:' + col + '">' + esc(nameOf(st, s.personId)) + " · done</div>" +
      '<div style="display:flex;align-items:baseline;gap:10px;margin-top:6px">' +
        '<span style="font-family:var(--font-display);font-weight:700;font-variant-numeric:tabular-nums;font-size:76px;line-height:1">' + s.total + "</span>" +
        '<span class="eyebrow">total ' + esc(w.unit) + "</span>" +
        (s.isBest ? '<span class="flag" style="margin-left:auto">New best</span>' : "") +
      "</div>" +
      '<div class="readings" style="margin-top:12px">' + s.values.map(function (v, i) {
        return '<div class="slot done"><div class="k">' + esc(w.round) + " " + (i + 1) + '</div><div class="v">' + v + "</div></div>";
      }).join("") + "</div>" +
      '<p class="lede" style="margin-top:12px">' + esc(line) + ".</p>" +
      '<div class="row" style="margin-top:16px">' +
        '<button type="button" class="btn ghost" data-act="done">Close</button>' +
        '<button type="button" class="btn" data-act="goprogress">See progress</button>' +
      "</div></section>";
  }

  function vProgress(st) {
    var w = M.words(st);
    var any = st.entries.length > 0;
    var out = '<section class="card">' +
      '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
        '<div class="eyebrow">Progress</div>' +
        '<div class="seg" style="margin-left:auto">' +
          '<button type="button" data-act="metric" data-m="total" aria-current="' + (S.metric === "total") + '">Total</button>' +
          '<button type="button" data-act="metric" data-m="best" aria-current="' + (S.metric === "best") + '">Best</button>' +
        "</div></div>" +
      (any ? '<div class="chartbox" style="margin-top:12px">' + chart(st) + "</div>"
           : '<p class="lede" style="margin-top:8px">The curve appears once there is an entry to plot. Add one on the Log tab.</p>') +
      (any ? '<div class="row" style="margin-top:6px">' + st.people.map(function (p) {
          return '<div class="note" style="color:' + (p.slot === 2 ? "var(--a2)" : "var(--a1)") + '"><span class="dot"></span> ' + esc(p.name) + "</div>";
        }).join("") + "</div>" : "") +
    "</section>";

    out += st.people.map(function (p) {
      var t = M.statsFor(st, p.id), col = p.slot === 2 ? "var(--a2)" : "var(--a1)";
      if (!t.n) {
        return '<section class="card"><div class="eyebrow" style="color:' + col + '">' + esc(p.name) + "</div>" +
          '<p class="lede" style="margin-top:6px">Nothing logged yet.</p></section>';
      }
      return '<section class="card"><div class="eyebrow" style="color:' + col + '">' + esc(p.name) + "</div>" +
        '<div class="statrow">' +
          '<div class="stat"><span class="k">Last total</span><span class="v" style="color:' + col + '">' + t.last.total + '</span><span class="d">' + esc(fmtDate(t.last.ts)) + "</span></div>" +
          '<div class="stat"><span class="k">Best</span><span class="v">' + t.bestSet + '</span><span class="d">single ' + esc(w.round.toLowerCase()) + "</span></div>" +
          '<div class="stat"><span class="k">Entries</span><span class="v">' + t.n + '</span><span class="d">' + (t.gain === null ? "—" : (t.gain > 0 ? "+" : "") + t.gain + " since first") + "</span></div>" +
        "</div></section>";
    }).join("");
    return out;
  }

  function vHistory(st) {
    if (!st.entries.length) {
      return '<section class="card"><div class="eyebrow">History</div>' +
        '<p class="lede" style="margin-top:6px">Nothing logged yet. Every finished entry lands here, newest first.</p></section>';
    }
    var items = st.entries.map(function (e) {
      var col = colorOf(st, e.personId), armed = S.armed === e.id;
      return "<li>" +
        '<span class="dot" style="color:' + col + '"></span>' +
        '<span style="min-width:0"><span class="nm">' + esc(nameOf(st, e.personId)) + "</span><br>" +
          '<span class="when">' + esc(fmtDate(e.ts)) + "</span></span>" +
        (isPending(e.id) ? '<span class="pend">unsaved</span>' : "") +
        '<span class="ss">' + e.values.join(" / ") + "</span>" +
        '<span class="tt" style="color:' + col + '">' + e.total + "</span>" +
        '<button type="button" class="x' + (armed ? " arm" : "") + '" data-act="del" data-id="' + esc(e.id) + '">' + (armed ? "Delete?" : "×") + "</button></li>";
    }).join("");
    return '<section class="card">' +
      '<div class="eyebrow">History · ' + st.entries.length + " entr" + (st.entries.length === 1 ? "y" : "ies") + "</div>" +
      '<ul class="log" style="margin-top:8px">' + items + "</ul></section>";
  }

  function vSettings(st) {
    var c = cfg(), w = M.words(st), l = st.labels || {};
    var people = st.people.length === 2
      ? '<section class="card"><div class="eyebrow">People</div>' +
        '<form class="form" id="people">' +
          '<div class="field"><label for="n1">Person one</label><input id="n1" maxlength="24" value="' + esc(st.people[0].name) + '" required></div>' +
          '<div class="field"><label for="n2">Person two</label><input id="n2" maxlength="24" value="' + esc(st.people[1].name) + '" required></div>' +
          '<button class="btn ghost" type="submit">Save names</button>' +
        "</form></section>"
      : "";
    var labels = '<section class="card"><div class="eyebrow">Wording</div>' +
      '<p class="lede" style="margin-top:6px">What the app calls things. These are stored inside the encrypted file, so they are only visible to someone who can open it.</p>' +
      '<form class="form" id="labels">' +
        '<div class="field"><label for="l-activity">Activity</label><input id="l-activity" maxlength="24" value="' + esc(l.activity || "") + '" placeholder="left blank"></div>' +
        '<div class="row">' +
          '<div class="field"><label for="l-unit">Unit</label><input id="l-unit" maxlength="16" value="' + esc(l.unit || "") + '" placeholder="count"></div>' +
          '<div class="field"><label for="l-round">Each reading</label><input id="l-round" maxlength="16" value="' + esc(l.round || "") + '" placeholder="Round"></div>' +
        "</div>" +
        '<button class="btn ghost" type="submit">Save wording</button>' +
      "</form></section>";
    return vConnect() + people + labels +
      '<section class="card"><div class="eyebrow">This log</div>' +
        '<div class="statrow">' +
          '<div class="stat"><span class="k">Entries</span><span class="v">' + st.entries.length + "</span></div>" +
          '<div class="stat"><span class="k">Revision</span><span class="v">' + (st.rev || 0) + "</span></div>" +
          '<div class="stat"><span class="k">Unsaved</span><span class="v">' + S.queue.length + "</span></div>" +
        "</div>" +
        '<p class="note mono" style="margin-top:12px">' + esc(c.owner + "/" + c.repo + " · " + c.branch + " · " + c.path) + "</p>" +
      "</section>" +
      '<section class="card"><div class="eyebrow">This device</div>' +
        '<p class="lede" style="margin-top:6px">The token and passphrase are stored in this browser only. Clearing them leaves the data untouched in the repo.</p>' +
        '<div class="row" style="margin-top:14px">' +
          '<button type="button" class="btn ghost" data-act="forget">' + (S.armed === "forget" ? "Tap again to confirm" : "Forget this device") + "</button>" +
        "</div></section>";
  }

  /* ------------------------------------------------------------------ *
   * render
   * ------------------------------------------------------------------ */
  function banner() {
    if (!SY.err) return "";
    var head = SY.err.kind === "net" ? "Offline" : SY.err.kind === "pass" ? "Passphrase" : "Sync problem";
    return '<section class="card warn"><div class="eyebrow">' + head + "</div>" +
      '<p class="lede" style="margin-top:4px;color:var(--fg)">' + esc(SY.err.message) +
      (S.queue.length ? " Your " + S.queue.length + " unsaved change" + (S.queue.length === 1 ? "" : "s") + " will go up on the next successful sync." : "") +
      "</p></section>";
  }

  function render() {
    var st = V();
    var html;
    if (S.view === "settings") html = banner() + vSettings(st);
    else if (!connected()) html = vConnect();
    else if (!S.loaded && !SY.err) {
      html = '<section class="card"><div class="eyebrow">Loading</div>' +
        '<div style="display:flex;flex-direction:column;gap:9px;margin-top:12px">' +
        '<div class="skel" style="width:70%"></div><div class="skel" style="width:45%"></div></div></section>';
    } else if (S.view === "log") {
      html = banner();
      if (st.people.length < 2) html += vSetupPeople();
      else if (S.summary) html += vSummary(st);
      else if (S.run) html += vRun(st);
      else html += vPick(st);
    } else if (S.view === "progress") html = banner() + vProgress(st);
    else html = banner() + vHistory(st);

    app.innerHTML = html;
    Array.prototype.forEach.call(nav.querySelectorAll("button"), function (b) {
      b.setAttribute("aria-current", String(b.dataset.v === S.view));
    });
    gear.setAttribute("aria-current", String(S.view === "settings"));
    renderStatus();
  }

  /* ------------------------------------------------------------------ *
   * actions
   * ------------------------------------------------------------------ */
  function setView(v) { S.view = v; S.armed = null; S.formError = null; render(); }

  function readingValue() {
    var el = document.getElementById("reading");
    var v = parseInt(el && el.value, 10);
    if (isNaN(v) || v < 0) v = 0;
    return v > 200 ? 200 : v;
  }
  function bump(d) {
    var el = document.getElementById("reading");
    if (!el) return;
    var v = readingValue() + d;
    el.value = v < 0 ? 0 : v > 200 ? 200 : v;
  }

  function saveReading() {
    if (!S.run) return;
    var st = V();
    S.run.values.push(readingValue());
    if (S.run.values.length < N) {
      S.run.nextAt = Date.now() + INTERVAL_MS;
      S.run.rang = false;
      persistRun(); holdScreen(true); render();
      return;
    }
    var values = S.run.values.slice(0, N);
    var prevList = M.forPerson(st, S.run.personId);
    var bestBefore = prevList.reduce(function (m, e) { return Math.max(m, e.best); }, 0);
    var entry = M.newEntry(S.run.personId, values);
    pushOp({ op: "add", entry: entry });
    S.summary = {
      personId: entry.personId, values: entry.values, total: entry.total,
      prev: prevList.length ? prevList[0] : null, isBest: entry.best > bestBefore
    };
    S.run = null; persistRun(); holdScreen(false);
    render(); sync();
  }

  function delEntry(id) {
    if (S.armed !== id) { S.armed = id; render(); return; }
    S.armed = null;
    var queued = S.queue.filter(function (o) { return o.op === "add" && o.entry.id === id; });
    if (queued.length) dropOps(queued.map(function (o) { return o.oid; }));
    else pushOp({ op: "del", id: id });
    render(); sync();
  }

  async function doConnect(owner, repo, tok, pass) {
    S.busy = true; S.formError = null; render();
    var prev = { cfg: cfg(), token: token(), pass: passphrase() };
    var c = {
      owner: owner, repo: repo,
      branch: prev.cfg.branch || "main",
      path: prev.cfg.path || "data/log.enc.json"
    };
    saveCfg(c); LS.set("dl.token", tok); LS.set("dl.pass", pass);
    C.clearKeys();
    try {
      var remote = await getRemote();
      setBase(remote.parsed ? await C.decryptFile(remote.parsed, pass) : M.emptyState());
      SY.lastSync = Date.now(); SY.err = null;
      S.busy = false;
      setView("log");
      sync();
    } catch (e) {
      saveCfg(prev.cfg);
      if (prev.token) LS.set("dl.token", prev.token); else LS.del("dl.token");
      if (prev.pass) LS.set("dl.pass", prev.pass); else LS.del("dl.pass");
      C.clearKeys();
      S.busy = false;
      S.formError = (e && e.message) || "Could not reach that repository.";
      render();
    }
  }

  function forgetDevice() {
    if (S.armed !== "forget") { S.armed = "forget"; render(); return; }
    ["dl.token", "dl.pass", "dl.state", "dl.queue", "dl.me", "dl.run", "dl.cfg"].forEach(LS.del);
    S.base = M.emptyState(); S.queue = []; S.loaded = false;
    S.me = null; S.run = null; S.armed = null; S.summary = null;
    SY.err = null; SY.lastSync = 0;
    C.clearKeys();
    setView("log");
  }

  /* ------------------------------------------------------------------ *
   * events
   * ------------------------------------------------------------------ */
  function onNav(ev) {
    var b = ev.target.closest("[data-act='view']");
    if (b) setView(b.dataset.v);
  }
  nav.addEventListener("click", onNav);
  gear.addEventListener("click", onNav);
  statusEl.addEventListener("click", function (ev) {
    if (ev.target.closest("[data-act='sync']")) sync();
  });

  app.addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-act]");
    if (!b) return;
    switch (b.dataset.act) {
      case "pick":
        S.me = b.dataset.id; LS.set("dl.me", S.me);
        S.run = { personId: S.me, values: [], nextAt: null, rang: false };
        persistRun(); render(); break;
      case "inc": bump(1); break;
      case "dec": bump(-1); break;
      case "save": saveReading(); break;
      case "cancel": S.run = null; persistRun(); holdScreen(false); render(); break;
      case "done": S.summary = null; render(); break;
      case "goprogress": S.summary = null; setView("progress"); break;
      case "metric": S.metric = b.dataset.m; render(); break;
      case "del": delEntry(b.dataset.id); break;
      case "forget": forgetDevice(); break;
    }
  });

  app.addEventListener("submit", function (ev) {
    var f = ev.target;
    if (f.id === "connect") {
      ev.preventDefault();
      doConnect(
        document.getElementById("f-owner").value.trim(),
        document.getElementById("f-repo").value.trim(),
        document.getElementById("f-token").value.trim(),
        document.getElementById("f-pass").value
      );
    } else if (f.id === "people") {
      ev.preventDefault();
      var n1 = document.getElementById("n1").value.trim().slice(0, 24);
      var n2 = document.getElementById("n2").value.trim().slice(0, 24);
      if (!n1 || !n2) return;
      pushOp({ op: "people", people: [{ id: "p1", name: n1, slot: 1 }, { id: "p2", name: n2, slot: 2 }] });
      render(); sync();
    } else if (f.id === "labels") {
      ev.preventDefault();
      pushOp({ op: "labels", labels: {
        activity: document.getElementById("l-activity").value.trim().slice(0, 24),
        unit: document.getElementById("l-unit").value.trim().slice(0, 16),
        round: document.getElementById("l-round").value.trim().slice(0, 16)
      } });
      render(); sync();
    }
  });

  /* ------------------------------------------------------------------ *
   * timers
   * ------------------------------------------------------------------ */
  setInterval(function () {
    if (!S.run || !S.run.nextAt) return;
    var ms = S.run.nextAt - Date.now();
    if (ms <= 0) {
      S.run.nextAt = null;
      if (!S.run.rang) { S.run.rang = true; buzz(); }
      persistRun(); holdScreen(false); render();
      return;
    }
    var txt = document.getElementById("ringtxt"), arc = document.getElementById("ringarc");
    if (txt) {
      var left = Math.ceil(ms / 1000);
      var big = txt.querySelector(".big");
      if (big && big.textContent !== String(left)) big.textContent = left;
      txt.classList.toggle("go", left <= 3);
    }
    if (arc) arc.setAttribute("stroke-dashoffset", ((1 - ms / INTERVAL_MS) * 2 * Math.PI * 82).toFixed(1));
  }, 200);

  setInterval(function () {
    if (document.visibilityState === "visible") renderStatus();
  }, 15000);

  setInterval(function () {
    if (document.visibilityState === "visible") sync();
  }, POLL_MS);

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible") return;
    if (S.run && S.run.nextAt) holdScreen(true);
    render(); sync();
  });
  window.addEventListener("online", sync);

  /* ------------------------------------------------------------------ *
   * boot
   * ------------------------------------------------------------------ */
  render();
  sync();

  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    });
  }
})();
