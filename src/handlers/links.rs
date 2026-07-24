use axum::Form;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Redirect;
use chrono::NaiveDateTime;
use serde::Deserialize;

use crate::AppState;
use crate::enrich;
use crate::error::AppError;
use crate::handlers::util::smart_redirect;
use crate::models::RemindIn;

#[derive(Debug, Deserialize)]
pub struct CreateForm {
    pub url: String,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub category_id: Option<String>,
    pub remind_in: RemindIn,
    #[serde(default)]
    pub custom_due_at: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SnoozeForm {
    pub remind_in: RemindIn,
    #[serde(default)]
    pub custom_due_at: Option<String>,
}

pub async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<CreateForm>,
) -> Result<Redirect, AppError> {
    let url = form.url.trim();
    if url.is_empty() {
        return Ok(smart_redirect(&state.pool, &headers).await);
    }
    if url::Url::parse(url).is_err() {
        return Err(AppError(anyhow::anyhow!("invalid URL: {}", url)));
    }

    let now = chrono::Utc::now().naive_utc();
    let custom = parse_custom(form.custom_due_at.as_deref());
    let due_at = form.remind_in.resolve(now, custom);

    let note = form.note.and_then(|n| {
        let t = n.trim();
        if t.is_empty() { None } else { Some(t.to_string()) }
    });
    let category_id: Option<i64> = form
        .category_id
        .as_deref()
        .and_then(|s| if s.is_empty() { None } else { s.parse().ok() });

    let link_id: i64 = sqlx::query_scalar(
        "INSERT INTO links (url, note, category_id, due_at) VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(url)
    .bind(&note)
    .bind(category_id)
    .bind(due_at)
    .fetch_one(&state.pool)
    .await?;

    let pool = state.pool.clone();
    let http = state.http.clone();
    let u = url.to_string();
    tokio::spawn(async move {
        if let Err(e) = enrich::fetch_and_store_title(&pool, &http, link_id, &u).await {
            tracing::warn!("enrichment failed for {}: {:?}", u, e);
        }
    });

    Ok(smart_redirect(&state.pool, &headers).await)
}

pub async fn mark_done(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Redirect, AppError> {
    let now = chrono::Utc::now().naive_utc();
    sqlx::query("UPDATE links SET done_at = $1 WHERE id = $2 AND done_at IS NULL")
        .bind(now)
        .bind(id)
        .execute(&state.pool)
        .await?;
    Ok(smart_redirect(&state.pool, &headers).await)
}

pub async fn reopen(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Redirect, AppError> {
    sqlx::query("UPDATE links SET done_at = NULL WHERE id = $1")
        .bind(id)
        .execute(&state.pool)
        .await?;
    Ok(smart_redirect(&state.pool, &headers).await)
}

pub async fn snooze(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Form(form): Form<SnoozeForm>,
) -> Result<Redirect, AppError> {
    let now = chrono::Utc::now().naive_utc();
    let custom = parse_custom(form.custom_due_at.as_deref());
    let due_at = form.remind_in.resolve(now, custom);
    sqlx::query(
        "UPDATE links SET due_at = $1, snoozed_count = snoozed_count + 1 WHERE id = $2",
    )
    .bind(due_at)
    .bind(id)
    .execute(&state.pool)
    .await?;
    Ok(smart_redirect(&state.pool, &headers).await)
}

pub async fn delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Redirect, AppError> {
    sqlx::query("DELETE FROM links WHERE id = $1")
        .bind(id)
        .execute(&state.pool)
        .await?;
    Ok(smart_redirect(&state.pool, &headers).await)
}

fn parse_custom(input: Option<&str>) -> Option<NaiveDateTime> {
    let s = input?.trim();
    if s.is_empty() {
        return None;
    }
    NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M")
        .or_else(|_| NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S"))
        .ok()
}
