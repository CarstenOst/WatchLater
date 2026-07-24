CREATE TABLE categories (
    id    BIGSERIAL PRIMARY KEY,
    name  TEXT NOT NULL UNIQUE,
    color TEXT
);

CREATE TABLE links (
    id            BIGSERIAL PRIMARY KEY,
    url           TEXT NOT NULL,
    title         TEXT,
    note          TEXT,
    category_id   BIGINT REFERENCES categories(id) ON DELETE SET NULL,
    created_at    TIMESTAMP NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc'),
    due_at        TIMESTAMP NOT NULL,
    done_at       TIMESTAMP,
    snoozed_count BIGINT NOT NULL DEFAULT 0
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
    id              BIGSERIAL PRIMARY KEY,
    link_id         BIGINT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
    due_at_snapshot TIMESTAMP NOT NULL,
    sent_at         TIMESTAMP NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc'),
    UNIQUE(link_id, due_at_snapshot)
);

INSERT INTO categories (name, color) VALUES
    ('Watch',   '#ef4444'),
    ('Read',    '#3b82f6'),
    ('General', '#6b7280');
