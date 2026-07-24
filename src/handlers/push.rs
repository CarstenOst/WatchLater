use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

use crate::AppState;
use crate::error::AppError;

pub async fn vapid_public_key(State(state): State<AppState>) -> Response {
    match state.vapid.as_ref() {
        Some(v) => (StatusCode::OK, v.public_b64.clone()).into_response(),
        None => (
            StatusCode::SERVICE_UNAVAILABLE,
            "Push not configured. Set VAPID_PRIVATE_KEY and VAPID_PUBLIC_KEY in .env.",
        )
            .into_response(),
    }
}

#[derive(Debug, Deserialize)]
pub struct SubscribeBody {
    pub endpoint: String,
    pub keys: SubscribeKeys,
}

#[derive(Debug, Deserialize)]
pub struct SubscribeKeys {
    pub p256dh: String,
    pub auth: String,
}

pub async fn subscribe(
    State(state): State<AppState>,
    Json(body): Json<SubscribeBody>,
) -> Result<StatusCode, AppError> {
    sqlx::query(
        "INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES ($1, $2, $3) \
         ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth",
    )
    .bind(&body.endpoint)
    .bind(&body.keys.p256dh)
    .bind(&body.keys.auth)
    .execute(&state.pool)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
pub struct UnsubscribeBody {
    pub endpoint: String,
}

pub async fn unsubscribe(
    State(state): State<AppState>,
    Json(body): Json<UnsubscribeBody>,
) -> Result<StatusCode, AppError> {
    sqlx::query("DELETE FROM push_subscriptions WHERE endpoint = $1")
        .bind(&body.endpoint)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
