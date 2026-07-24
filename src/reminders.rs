use std::time::Duration;

use crate::AppState;
use crate::push;

pub async fn run(state: AppState) {
    let mut ticker = tokio::time::interval(Duration::from_secs(60));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        if let Err(e) = tick(&state).await {
            tracing::warn!("reminder tick error: {:?}", e);
        }
    }
}

async fn tick(state: &AppState) -> anyhow::Result<()> {
    let now = chrono::Utc::now().naive_utc();
    let rows: Vec<(i64, String, Option<String>, chrono::NaiveDateTime)> = sqlx::query_as(
        "SELECT l.id, l.url, l.title, l.due_at \
         FROM links l \
         WHERE l.done_at IS NULL AND l.due_at <= $1 \
           AND NOT EXISTS ( \
               SELECT 1 FROM reminder_log r \
               WHERE r.link_id = l.id AND r.due_at_snapshot = l.due_at \
           ) \
         LIMIT 50",
    )
    .bind(now)
    .fetch_all(&state.pool)
    .await?;

    if rows.is_empty() {
        return Ok(());
    }

    let Some(vapid) = state.vapid.as_ref() else {
        tracing::debug!("{} links due but push not configured", rows.len());
        return Ok(());
    };

    for (id, url, title, due_at) in rows {
        let display = title.as_deref().filter(|t| !t.trim().is_empty()).unwrap_or(&url);
        if let Err(e) = push::send_notification(
            &state.pool,
            vapid,
            "WatchLater reminder",
            display,
            &url,
        )
        .await
        {
            tracing::warn!("push send failed for link {}: {:?}", id, e);
            continue;
        }
        sqlx::query(
            "INSERT INTO reminder_log (link_id, due_at_snapshot) VALUES ($1, $2) \
             ON CONFLICT (link_id, due_at_snapshot) DO NOTHING",
        )
        .bind(id)
        .bind(due_at)
        .execute(&state.pool)
        .await?;
    }
    Ok(())
}
