# Daily Log

A small shared tracker for two people. Each entry is three readings taken in
one sitting, ninety seconds apart, and the app charts how they move over time.

No server, no database, no account to sign up for. The page is static and runs
on GitHub Pages. The data lives in one JSON file in this repo, encrypted in the
browser before it is ever committed, so the repo can be public while its
contents are not.

---

## What it does

- **Guided entry.** Pick who is logging, save the first reading, and a
  90-second countdown starts on its own. The next one unlocks at zero and the
  phone buzzes. Three readings, then the entry is saved.
- **Seeded input.** Each reading opens pre-filled with the matching value from
  that person's last entry, so logging is usually one tap.
- **Progress.** Totals or best single reading per entry, one line per person,
  plus last total, best, entries logged and change since the first.
- **History.** Every entry, newest first, with a two-tap delete.
- **Installable.** Add it to your home screen and it opens full screen and
  works offline; entries made without signal queue up and push on reconnect.
- **Your own wording.** Settings holds a label for the activity, the unit and
  what to call each reading. They are stored inside the encrypted file, so the
  app reads naturally for you without the repo saying what it tracks.

---

## Setup

### 1. Create the repository

Push these files to a **public** repo (the data in it is encrypted; see
[Security](#security)). Then in **Settings → Pages**, set the source to
*Deploy from a branch*, branch `main`, folder `/ (root)`. The app appears at:

```
https://<your-user>.github.io/<repo>/
```

Give it a minute on the first deploy.

### 2. Create an access token

Each device needs a token to write to the repo. One token can be shared, or
make one each — the app does not care who commits.

Go to **[Settings → Developer settings → Personal access tokens → Fine-grained
tokens](https://github.com/settings/personal-access-tokens/new)** and create one
with:

| Field | Value |
| --- | --- |
| Repository access | **Only select repositories** → this repo |
| Permissions → Repository → **Contents** | **Read and write** |
| Expiration | your call; you will have to replace it when it lapses |

Nothing else. Contents is the only permission the app uses.

### 3. Agree on a passphrase

Pick one passphrase everyone uses. It is what encrypts the file, so a few
random words beat one clever word. **If it is lost, the data is unreadable —
there is no reset.** Keep it in a password manager.

### 4. Connect each device

Open the Pages URL, go to the gear icon, and fill in user, repo, token and
passphrase. The first device to connect is asked for the two names; that writes
the first commit. Every device after that just reads the existing file.

---

## Security

What this protects, and what it does not.

**Encrypted.** `data/log.enc.json` is AES-GCM-256 ciphertext. The key is
derived from the passphrase with PBKDF2-SHA256, 600,000 iterations, over a
random 16-byte salt stored in the file. A fresh 12-byte IV is drawn for every
save. All of it runs in the browser through the Web Crypto API; the plaintext
and the passphrase never leave the device.

**Still public, even so:**

- Anyone can see **that** commits happen, **when**, and roughly how big the
  file is. The rhythm of use is visible even though the contents are not.
- Every historical version stays in the git history as ciphertext.
- Strength rests entirely on the passphrase. A short or guessable one can be
  attacked offline by anyone who clones the repo, as fast as their hardware
  allows. Use a long one.

**The token** is a real credential, stored in `localStorage` on each device. If
a phone is lost, [revoke that token](https://github.com/settings/tokens) — it
can write to this one repo and nothing else, as long as you scoped it as above.
"Forget this device" in Settings clears the token and passphrase from that
browser without touching the data in the repo.

If you would rather nothing at all were public, use a **private** repo plus a
host that serves private repos for free (Cloudflare Pages, Netlify); GitHub
Pages needs a paid plan for that. Nothing in the app changes.

---

## How it stores things

```
data/log.enc.json     everything, encrypted
```

Decrypted, the file is:

```json
{
  "people":  [{ "id": "p1", "name": "…", "slot": 1 }],
  "entries": [{ "id": "…", "personId": "p1", "ts": 1762600000000,
                "values": [11, 8, 6], "total": 25, "best": 11 }],
  "labels":  { "activity": "", "unit": "count", "round": "Round" },
  "deleted": ["…"],
  "rev": 42,
  "updatedAt": "2026-11-08T19:00:00.000Z"
}
```

Writes go through the GitHub contents API, so each entry is a commit. The app
never blind-writes: it fetches the current file, decrypts, replays whatever is
queued on that device, re-encrypts and commits against the SHA it just read. If
another device got there first, GitHub rejects it and the app retries on the
new version — so two people logging at the same moment cannot clobber each
other.

Entries carry their own ids and deletes leave tombstones, which is what makes
an offline queue safe to replay later.

The app polls for changes every 60 seconds while open and on every focus. It is
not live — simultaneous writers see each other within the minute.

---

## Running it locally

Any static server will do; a service worker and the Web Crypto API both need
`localhost` or HTTPS, so opening `index.html` from the filesystem will not work.

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000/>.

---

## Layout

```
index.html              markup and the app shell
app.css                 all styling, light and dark
crypto.js               encrypt/decrypt the data file
model.js                data model and the merge rules
app.js                  GitHub storage, sync queue, UI
sw.js                   offline shell cache
manifest.webmanifest    home-screen install
fonts/                  Barlow and Barlow Condensed, self-hosted
icons/                  app icons
data/                   created on your first save
```

No build step, no dependencies, no third-party requests at runtime — the only
network calls are to `api.github.com`.

---

## Changing things

A few knobs near the top of `app.js` and `model.js`:

| Constant | Default | What it is |
| --- | --- | --- |
| `INTERVAL_MS` | `90000` | the gap between readings |
| `READINGS` | `3` | readings per entry (`model.js`) |
| `ITER` | `600000` | PBKDF2 iterations (`crypto.js`; changing it re-keys on next save) |
| `POLL_MS` | `60000` | how often an open page checks for another device's writes |

---

## Credits

Barlow and Barlow Condensed by Jeremy Tribby, under the
[SIL Open Font License 1.1](https://openfontlicense.org/).
