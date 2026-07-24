# WatchLater

Personal "read/watch later" app: paste a link, pick a category, set a reminder, and get a browser push notification when it's due.

## Scope (v1)

- Add links (URL + optional note + category)
- Paste-from-clipboard button
- User-defined categories with inline "+ Category" form
- Category filter dropdown (active count per category) on inbox & done; filter persists across mutations and only drops when its category becomes empty
- Reminder presets (8h / 24h / 1 week) + custom datetime
- List views: Due now, Upcoming, Done
- Snooze / mark done / reopen / delete
- URL title enrichment, with `og:title` preferred and YouTube/Reddit suffix stripping
- Web Push notifications (PWA) when a reminder fires
- PWA share-target route stubbed now, activated once we move off pure localhost

**Out of scope for v1:** multi-user, auth, thumbnails, full-text search, import/export, native mobile.

## Runtime & deployment

- Local-only on `http://127.0.0.1:3420`. No auth — the bind address is the access control.
- Postgres runs in Docker via `docker compose up -d db` (single named volume `watchlater_pgdata` for persistence). Default port mapping is `5433:5432` to avoid colliding with a local Postgres install.
- Web Push works on `localhost` (browsers treat it as a secure context) — no HTTPS needed for local dev.
- Future: Cloudflare Tunnel + a single shared-password session. Do **not** add auth plumbing preemptively; we'll bolt it on at that point.

## Tech stack

- **Backend:** `axum`, `tokio`, `sqlx` (Postgres), `tower-http` for static files and tracing.
- **Database:** Postgres 17 in Docker. Connection retried at app startup so the app can race a cold container.
- **Templates:** `askama` (compile-time checked). One `base.html` + page templates + partials included via `{% include %}`.
- **Interactivity:** HTMX with `hx-boost="true"` on `<body>` — form submits and links go via AJAX, server returns full pages, no partial rendering required.
- **CSS:** Tailwind via the v3 Play CDN (dev only). Replace with the standalone CLI compiling `templates/**/*.html` → `static/app.css` when we want to drop the CDN.
- **Push:** `web-push` crate with VAPID keys. Keys generated externally (`npx web-push generate-vapid-keys` or openssl), stored in `.env` (gitignored). App runs without push if keys are unset.
- **URL enrichment:** `reqwest` fetch (3s timeout, 256KB cap). Prefers `<meta property="og:title">` then `<title>`, with YouTube `" - YouTube"` and Reddit `" : r/sub"` / `" - reddit"` suffixes stripped.

Rationale: HTMX + Askama keeps bytes-over-the-wire minimal and eliminates JS build tooling. Postgres in Docker gives us a real durable DB with one command. Standalone Tailwind avoids a Node dependency for the prod build.

The only client-side JS: the service worker (`sw.js`), the push-subscription flow (`push.js`), the snooze details widget, and the paste-from-clipboard inline handler.

## Architecture

- `main.rs` — load config, open Postgres pool (with retry), run embedded migrations, wire router, spawn reminder tick task.
- `reminders.rs` — `tokio::time::interval(60s)` loop. Selects rows where `due_at <= now()` AND `done_at IS NULL` AND no matching `reminder_log` row for this `(link_id, due_at)` pair. Sends push via `web-push`. Logs the send.
- `enrich.rs` — spawned after insert; updates `links.title` when resolved.
- `handlers/`
  - `pages.rs` — `GET /`, `GET /done`, plus `/sw.js` and `/manifest.webmanifest` content-type wrappers.
  - `links.rs` — create / mark_done / reopen / snooze / delete. All mutation handlers return via `smart_redirect`.
  - `categories.rs` — create only. (No standalone `/categories` page; add UI lives inline next to the filter.)
  - `push.rs` — VAPID public-key endpoint + subscribe/unsubscribe.
  - `util.rs::smart_redirect` — reads `Referer` to preserve `?category=…` across mutations. Drops the filter only when the filtered view at that category is empty.
- `templates.rs` — `#[derive(Template)]` structs.

## Schema

Reference for `migrations/0001_init.sql`:

```sql
CREATE TABLE categories (
  id    BIGSERIAL PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE,
  color TEXT
);

CREATE TABLE links (
  id             BIGSERIAL PRIMARY KEY,
  url            TEXT NOT NULL,
  title          TEXT,
  note           TEXT,
  category_id    BIGINT REFERENCES categories(id) ON DELETE SET NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc'),
  due_at         TIMESTAMP NOT NULL,
  done_at        TIMESTAMP,
  snoozed_count  BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX idx_links_due ON links(due_at) WHERE done_at IS NULL;

CREATE TABLE push_subscriptions (
  id         BIGSERIAL PRIMARY KEY,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc')
);

CREATE TABLE reminder_log (
  id               BIGSERIAL PRIMARY KEY,
  link_id          BIGINT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  due_at_snapshot  TIMESTAMP NOT NULL,
  sent_at          TIMESTAMP NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc'),
  UNIQUE(link_id, due_at_snapshot)
);
```

`due_at_snapshot` lets snooze re-arm the same link by updating `due_at` — we match `(link, due_at)` to prevent double-sends without forgetting the link. Timestamps are `TIMESTAMP` (no tz) and treated as UTC throughout.

## Project layout

```
src/
  main.rs
  config.rs        env loading
  db.rs            pool + embedded migrations + connect retry
  models.rs        domain types
  reminders.rs     tick loop + push send
  enrich.rs        title fetch
  error.rs         AppError → IntoResponse
  push.rs          web-push send + VAPID
  handlers/
    mod.rs
    pages.rs
    links.rs
    categories.rs
    push.rs
    util.rs        smart_redirect (filter persistence)
  templates.rs
migrations/
  0001_init.sql
templates/
  base.html
  index.html
  done.html
  partials/
    add_form.html
    link_row.html
    category_filter.html
static/
  manifest.webmanifest
  sw.js
  push.js
  icon.svg
docker-compose.yml
```

## Conventions

- Handlers return `askama::Template` impls wrapped into `Html<String>` via `error::HtmlTemplate`.
- All form-mutation handlers return via `smart_redirect` so `?category=…` survives. Don't redirect by hardcoded `/` or `/done`.
- Time: store UTC `NaiveDateTime`; comparisons in SQL use the same.
- No `unwrap()` in request paths. Internal `anyhow::Result`, single `AppError` → `IntoResponse`.
- Migrations embedded via `sqlx::migrate!("./migrations").run(&pool)` at startup — no `sqlx-cli` needed.
- SQL placeholders are `$1, $2, …` (Postgres). `INSERT … ON CONFLICT (col) DO …` for upsert/ignore. `RETURNING id` for newly inserted rows.
- Don't pre-build abstractions for the "future Cloudflare Tunnel + password" case; add them when we flip the switch.

## Dev commands

```sh
docker compose up -d db    # starts Postgres (idempotent; data lives in named volume)
cargo run                  # starts the app on :3420; auto-runs migrations
docker compose stop db     # stop without losing data
docker compose down -v     # WIPES the volume — only when you actually want a clean slate
```

VAPID keys (optional, for Web Push): generate with `npx web-push generate-vapid-keys`, paste into `.env` (template in `.env.example`).

## Open items

- Mobile share target needs HTTPS — deferred until Cloudflare Tunnel is set up.
- iOS Web Push requires the site to be installed as a PWA to home screen (iOS 16.4+). Not a blocker for desktop Chrome/Firefox.
- Tailwind is via Play CDN; switch to standalone-CLI build when convenient.
