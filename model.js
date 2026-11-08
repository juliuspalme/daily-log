/* Daily Log — the data model.
 *
 * A log is a plain object. Changes are recorded as operations, which are
 * replayed onto whatever the repo currently holds. That is what lets two
 * devices write at once, and what lets a device with no signal catch up.
 *
 * An entry holds three readings taken in one sitting, with a timed interval
 * between each. What those readings mean is up to you: the wording shown in
 * the app comes from `labels`, which lives inside the encrypted file.
 */
window.AppModel = (function () {
  "use strict";

  var MAX_TOMBSTONES = 500;
  var READINGS = 3;

  function emptyState() {
    return { people: [], entries: [], deleted: [], labels: {}, rev: 0, updatedAt: null };
  }

  /** Replay ops onto a state, in place. Adds are idempotent and a deleted
   *  entry never comes back, so replaying a queue twice is harmless. */
  function applyOps(st, ops) {
    st.people = st.people || [];
    st.entries = st.entries || [];
    st.deleted = st.deleted || [];
    st.labels = st.labels || {};
    ops.forEach(function (o) {
      if (o.op === "people") {
        st.people = o.people.slice(0, 2);
      } else if (o.op === "labels") {
        st.labels = o.labels || {};
      } else if (o.op === "add") {
        var dup = st.entries.some(function (e) { return e.id === o.entry.id; });
        if (!dup && st.deleted.indexOf(o.entry.id) < 0) st.entries.push(o.entry);
      } else if (o.op === "del") {
        st.entries = st.entries.filter(function (e) { return e.id !== o.id; });
        if (st.deleted.indexOf(o.id) < 0) st.deleted.push(o.id);
        if (st.deleted.length > MAX_TOMBSTONES) st.deleted = st.deleted.slice(-MAX_TOMBSTONES);
      }
    });
    st.entries.sort(function (a, b) { return b.ts - a.ts; });
    return st;
  }

  function clone(st) { return JSON.parse(JSON.stringify(st)); }

  function sum(a) { var t = 0; for (var i = 0; i < a.length; i++) t += a[i]; return t; }
  function maxOf(a) { var m = 0; for (var i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m; }

  function newEntry(personId, values, ts) {
    values = values.slice(0, READINGS).map(Number);
    return {
      id: (ts || Date.now()).toString(36) + "-" + Math.random().toString(36).slice(2, 7),
      personId: personId,
      ts: ts || Date.now(),
      values: values,
      total: sum(values),
      best: maxOf(values)
    };
  }

  function forPerson(st, id) {
    return st.entries.filter(function (e) { return e.personId === id; });
  }
  function person(st, id) {
    for (var i = 0; i < st.people.length; i++) if (st.people[i].id === id) return st.people[i];
    return null;
  }

  /** Oldest first — the order a chart wants. */
  function chronological(st, id) {
    return forPerson(st, id).slice().sort(function (a, b) { return a.ts - b.ts; });
  }

  function statsFor(st, id) {
    var list = chronological(st, id);
    if (!list.length) return { n: 0 };
    return {
      n: list.length,
      last: list[list.length - 1],
      bestSet: Math.max.apply(null, list.map(function (e) { return e.best; })),
      bestTotal: Math.max.apply(null, list.map(function (e) { return e.total; })),
      gain: list.length > 1 ? list[list.length - 1].total - list[0].total : null
    };
  }

  /** Wording for the UI. Blank labels fall back to neutral words. */
  function words(st) {
    var l = (st && st.labels) || {};
    return {
      activity: l.activity || "",
      unit: l.unit || "count",
      round: l.round || "Round"
    };
  }

  return {
    READINGS: READINGS,
    emptyState: emptyState, applyOps: applyOps, clone: clone,
    newEntry: newEntry, sum: sum, maxOf: maxOf, words: words,
    person: person, forPerson: forPerson, chronological: chronological, statsFor: statsFor
  };
})();
