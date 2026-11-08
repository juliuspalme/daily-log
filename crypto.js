/* Daily Log — encryption.
 *
 * AES-GCM-256 over a PBKDF2-SHA256 key derived from the shared passphrase.
 * The salt lives in the file so any device with the passphrase can open it;
 * a fresh IV is drawn for every save. Everything runs in the browser.
 */
window.AppCrypto = (function () {
  "use strict";

  var FORMAT = "daily-log.v1";
  // The data file sits in a public repo, so a weak passphrase can be attacked
  // offline. 600k is the current OWASP figure for PBKDF2-SHA256; it costs a
  // phone a few hundred ms once per page load, and the key is then cached.
  var ITER = 600000;

  var TE = new TextEncoder();
  var TD = new TextDecoder();

  function bytesToB64(buf) {
    var a = new Uint8Array(buf), s = "", CH = 0x8000;
    for (var i = 0; i < a.length; i += CH) s += String.fromCharCode.apply(null, a.subarray(i, i + CH));
    return btoa(s);
  }
  function b64ToBytes(str) {
    var bin = atob(String(str).replace(/\s/g, ""));
    var a = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  }
  function strToB64(s) { return bytesToB64(TE.encode(s)); }
  function b64ToStr(b) { return TD.decode(b64ToBytes(b)); }

  var keyCache = Object.create(null);
  function clearKeys() { keyCache = Object.create(null); }

  async function deriveKey(pass, saltB64, iter) {
    var ck = pass + "|" + saltB64 + "|" + iter;
    if (keyCache[ck]) return keyCache[ck];
    var base = await crypto.subtle.importKey("raw", TE.encode(pass), "PBKDF2", false, ["deriveKey"]);
    keyCache[ck] = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: b64ToBytes(saltB64), iterations: iter, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    );
    return keyCache[ck];
  }

  function newKdf() {
    return {
      name: "PBKDF2", hash: "SHA-256", iterations: ITER,
      salt: bytesToB64(crypto.getRandomValues(new Uint8Array(16)))
    };
  }

  /** state + passphrase -> the text to commit. Reuses the file's existing
   *  salt when there is one, so the passphrase keeps working. */
  async function encryptState(state, pass, kdf) {
    if (!kdf || !kdf.salt) kdf = newKdf();
    var key = await deriveKey(pass, kdf.salt, kdf.iterations || ITER);
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, TE.encode(JSON.stringify(state)));
    return JSON.stringify({ format: FORMAT, kdf: kdf, iv: bytesToB64(iv), ct: bytesToB64(ct) }, null, 1) + "\n";
  }

  /** parsed file + passphrase -> state. Throws {kind:"pass"} when the
   *  passphrase is wrong (GCM authentication fails). */
  async function decryptFile(parsed, pass) {
    if (!parsed || parsed.format !== FORMAT || !parsed.kdf || !parsed.ct) {
      throw { kind: "format", message: "That file is not a Daily Log data file." };
    }
    var key = await deriveKey(pass, parsed.kdf.salt, parsed.kdf.iterations || ITER);
    var plain;
    try {
      plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(parsed.iv) }, key, b64ToBytes(parsed.ct));
    } catch (e) {
      throw { kind: "pass", message: "That passphrase does not match this log." };
    }
    return JSON.parse(TD.decode(plain));
  }

  return {
    FORMAT: FORMAT, ITER: ITER,
    bytesToB64: bytesToB64, b64ToBytes: b64ToBytes, strToB64: strToB64, b64ToStr: b64ToStr,
    encryptState: encryptState, decryptFile: decryptFile, clearKeys: clearKeys
  };
})();
