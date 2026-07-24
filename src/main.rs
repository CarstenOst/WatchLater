use std::sync::Arc;

use anyhow::Result;
use axum::Router;
use tower_http::services::ServeDir;
use tower_http::trace::TraceLayer;

mod config;
mod db;
mod enrich;
mod error;
mod handlers;
mod models;
mod push;
mod reminders;
mod templates;

#[derive(Clone)]
pub struct AppState {
    pub pool: sqlx::PgPool,
    pub http: reqwest::Client,
    pub vapid: Arc<Option<push::VapidKeys>>,
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "watchlater=info,tower_http=info".into()),
        )
        .init();

    let config = config::Config::from_env()?;
    let pool = db::init(&config.db_url).await?;
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .user_agent("WatchLater/0.1")
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()?;
    let vapid = push::VapidKeys::load(
        config.vapid_private_pem.clone(),
        config.vapid_public_b64.clone(),
        config.vapid_subject.clone(),
    );
    if vapid.is_none() {
        tracing::warn!(
            "VAPID keys not set — push notifications disabled. See .env.example."
        );
    }
    let state = AppState {
        pool: pool.clone(),
        http,
        vapid: Arc::new(vapid),
    };

    let reminder_state = state.clone();
    tokio::spawn(async move { reminders::run(reminder_state).await });

    let app = Router::new()
        .merge(handlers::router())
        .nest_service("/static", ServeDir::new("static"))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr = format!("127.0.0.1:{}", config.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("WatchLater listening on http://{}", addr);
    axum::serve(listener, app).await?;
    Ok(())
}
