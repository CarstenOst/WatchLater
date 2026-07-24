# WatchLater

Personal "read/watch later" app: paste a link, pick a category, set a reminder. Fully static — vanilla JS served from GitHub Pages, all data on-device in IndexedDB. No accounts, no server, no sync. The original Rust/axum + Postgres server implementation is preserved at tag `server-v1`.

## Scope (v2, static)

- Add links (URL + optional note + category), paste-from-clipboard button
- User-defined categories with inline "+ Category" form
- Category filter dropdown (active count per category) on both views; filter persists across mutations and only drops when the filtered current view becomes empty
- Reminder presets (8h / 24h / 1 week) + custom `datetime-local`
- Views: Inbox (Due now / Upcoming), Done (200 most recent)
- Snooze (always from now) / mark done / reopen / delete
- Best-effort title enrichment via noembed.com, with YouTube/Reddit suffix stripping
- Best-effort notifications: open-tab 60s tick + on-focus checks, Periodic Background Sync on installed Chromium; app badge + `(n)` tab-title count
- JSON export/import — the backup **and** device-transfer story (data is per-device)
- PWA: offline app shell, share target (Android, installed)

**Out of scope:** multi-user, auth, thumbnails, search, native mobile, cross-device sync. True background push is deferred to a future Cloudflare Worker relay — `settings.relayUrl` is reserved and `sw.js` keeps a dormant `push` handler with payload contract `{title, body, url}`. Do **not** build relay plumbing preemptively.

## Runtime & deployment

- GitHub Pages serves the repo root of `main`: `https://<user>.github.io/WatchLater/`.
- Local dev: `python3 -m http.server 8000` → http://localhost:8000/ (localhost is a secure context — SW, notifications, clipboard all work).
- Deploying = pushing to `main` (~1 min build + up to 10 min edge cache). The footer shows the running service-worker VERSION.

## Tech stack

- Vanilla JS. No framework, no build step, no npm, no CDN.
- **CSS:** Tailwind standalone CLI **v3.4.17** (pinned — v4 changed config + some defaults), compiled once to a committed `app.css`. The `tailwindcss` binary is gitignored.
- **Storage:** IndexedDB, one JSON document (db `watchlater`, store `state`, key `root`) behind `db.js` (`self.wlDB`), loaded by the page via `<script>` and by the SW via `importScripts`. IndexedDB (not localStorage) because the SW must read state for `periodicsync` and, later, the push relay.
- **Routing:** hash-based (`#/`, `#/done`, filter `?cat=<uuid>` inside the hash) — one real document URL under the `/WatchLater/` subpath, no Pages 404 hacks.
- **Enrichment:** noembed.com (CORS-enabled oEmbed, ~150 providers incl. YouTube/Vimeo/Reddit). Best-effort and isolated; if it dies, links fall back to domain-label titles.

## Data model

```js
{
  schemaVersion: 1,
  categories: [{ id: uuid, name, color /* string|null */ }],
  links: [{
    id: uuid, url, title: null,      // title only set by enrichment, never overwritten
    note: null, categoryId: null,
    createdAt, dueAt, doneAt: null,  // all timestamps epoch ms
    snoozedCount: 0,
    notifiedDueAt: null              // replaces v1's reminder_log(link_id, due_at_snapshot)
  }],
  settings: {}                       // reserved: relayUrl, persistRequested
}
```

`notifiedDueAt` semantics: a link is due-and-unnotified when `!doneAt && dueAt <= now && notifiedDueAt !== dueAt`; it is stamped to `dueAt` when claimed for notification. Snooze sets a new `dueAt` → re-arms. Reopen touches neither → no re-notify. Claims only happen while notification permission is granted, so reminders are never consumed invisibly (v1 parity: no `reminder_log` rows while push was unconfigured). First-run seed: Watch `#ef4444`, Read `#3b82f6`, General `#6b7280`.

## Architecture

- `index.html` — static shell: nav, `<main id="app">`, export/import footer. Never re-rendered.
- `db.js` — IDB wrapper. `wlDB.update(mutator)` = get → mutate → put in **one** readwrite transaction; mutators must be synchronous; a mutator returning `undefined` writes nothing (SW never seeds).
- `app.js` — sections in order: router, view helpers, renders (markup ported from `server-v1` Askama partials), actions, reminders, enrichment, share target, export/import, SW UX, boot. Every mutation goes through `mutate()`.
- `sw.js` — versioned app-shell precache (cache-first; the VERSION is the atomic deploy unit), `periodicsync` due-check, dormant `push`, `notificationclick` (link notifications open a new tab; only `./` focuses the app), version postMessage.

## Platform truth

- **Notifications** fire while the app/tab is open (60s tick + on focus/open), plus occasional background checks on *installed Chromium* via Periodic Background Sync (~12 h floor, site-engagement-gated). It is never a precise scheduler.
- **Badging**: Chromium desktop + Safari macOS 17+/iOS 16.4+ (installed). Not Chrome-Android/Firefox — the `(n)` tab-title count is the universal fallback.
- **iOS**: add WatchLater to the Home Screen (Share → Add to Home Screen). Reminders appear when the app is opened; iOS does not let web apps check for due links in the background, so no background notifications or live badge updates until the push relay exists. In a regular Safari tab, the Notification API doesn't exist and Safari may delete local data after 7 days without a visit — installed-app storage is exempt. Use Export for backups either way.

## Conventions

- Every path relative (`./…`) — the app must work under `/WatchLater/`. Never leading-slash.
- Timestamps are epoch ms; `datetime-local` input parses as **local** time (deliberate fix of v1's wall-clock-as-UTC bug).
- All state changes via `mutate()` → `wlDB.update` with a synchronous mutator, then filter-drop rule → render → `checkReminders()`.
- Claim-then-notify: stamp `notifiedDueAt` inside the transaction, commit, then `showNotification` from the claimed list. Never hold an IDB transaction across a non-IDB `await`. Always `registration.showNotification(...)`, never `new Notification()` (throws on Android, absent on iOS).
- `escapeHtml()` every user string in template literals; `safeColor()` before any style injection (imported data is untrusted).
- **Bump `VERSION` in `sw.js` in the same commit as any change to a precached file.** GH Pages serves `max-age=600`; `updateViaCache:'none'` + `cache:'reload'` handle the rest, but a forgotten bump ships bytes no existing user will load.
- `app.css` is generated — rebuild and commit it whenever classes change (content globs: `index.html`, `app.js`).
- Enrichment: one attempt per link at add-time; never overwrite a non-empty title; no arbitrary-site fetch fallback (CORS makes it pure console noise).

## Dev commands

```sh
python3 -m http.server 8000    # local dev server (SW works on localhost)
# regression harness: open http://localhost:8000/test.html — drives the real
# app in an iframe; results render in-page (title = ALL-PASS / FAILS:n)

# rebuild CSS after class changes (one-time binary download, gitignored):
curl -sL -o tailwindcss https://github.com/tailwindlabs/tailwindcss/releases/download/v3.4.17/tailwindcss-macos-arm64
chmod +x tailwindcss
./tailwindcss -c tailwind.config.js -i tailwind.in.css -o app.css --minify

# regenerate icons from icon.svg (one-off; full-bleed variant: rx="32" → rx="0"):
qlmanage -t -s 512 -o . icon.svg   # → icon.svg.png, then sips -z to 192/180
```

## Open items

- Cloudflare Worker push relay for real background push (incl. iOS): needs a subscribe flow + schedule upload on mutation; the dormant `push` handler and `{title, body, url}` contract are already in place.
- Maskable icon is a plain full-bleed square; could get proper safe-zone artwork.
- Cross-device sync stays out of scope; export/import is the transfer path.
