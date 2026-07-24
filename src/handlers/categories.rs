use axum::Form;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Redirect;
use serde::Deserialize;

use crate::AppState;
use crate::error::AppError;
use crate::handlers::util::smart_redirect;

#[derive(Debug, Deserialize)]
pub struct CreateForm {
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
}

pub async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<CreateForm>,
) -> Result<Redirect, AppError> {
    let name = form.name.trim();
    if name.is_empty() {
        return Ok(smart_redirect(&state.pool, &headers).await);
    }
    let color = form.color.and_then(|c| {
        let t = c.trim();
        if t.is_empty() { None } else { Some(t.to_string()) }
    });
    sqlx::query("INSERT INTO categories (name, color) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING")
        .bind(name)
        .bind(color)
        .execute(&state.pool)
        .await?;
    Ok(smart_redirect(&state.pool, &headers).await)
}
