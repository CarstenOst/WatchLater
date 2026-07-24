pub mod categories;
pub mod links;
pub mod pages;
pub mod push;
pub mod util;

use axum::Router;
use axum::routing::{get, post};

use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(pages::index))
        .route("/done", get(pages::done))
        .route("/categories", post(categories::create))
        .route("/links", post(links::create))
        .route("/links/{id}/done", post(links::mark_done))
        .route("/links/{id}/reopen", post(links::reopen))
        .route("/links/{id}/snooze", post(links::snooze))
        .route("/links/{id}/delete", post(links::delete))
        .route("/push/vapid-public-key", get(push::vapid_public_key))
        .route("/push/subscribe", post(push::subscribe))
        .route("/push/unsubscribe", post(push::unsubscribe))
        .route("/sw.js", get(pages::service_worker))
        .route("/manifest.webmanifest", get(pages::manifest))
}
