use axum::extract::{Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

use crate::AppState;
use crate::error::{AppError, HtmlTemplate};
use crate::models::{Category, CategoryWithCounts, Link, LinkView};
use crate::templates::{DoneTemplate, IndexTemplate};

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    #[serde(default)]
    pub category: Option<String>,
}

impl ListQuery {
    fn category_id(&self) -> Option<i64> {
        self.category
            .as_deref()
            .and_then(|s| if s.is_empty() { None } else { s.parse().ok() })
    }
}

pub async fn index(
    State(state): State<AppState>,
    Query(query): Query<ListQuery>,
) -> Result<HtmlTemplate<IndexTemplate>, AppError> {
    let now = chrono::Utc::now().naive_utc();
    let categories = load_categories_with_counts(&state.pool).await?;
    let cat_map = cat_lookup(&categories);
    let filter = query.category_id();

    let links: Vec<Link> = match filter {
        Some(id) => sqlx::query_as(
            "SELECT id, url, title, note, category_id, created_at, due_at, done_at, snoozed_count \
             FROM links WHERE done_at IS NULL AND category_id = $1 ORDER BY due_at ASC",
        )
        .bind(id)
        .fetch_all(&state.pool)
        .await?,
        None => sqlx::query_as(
            "SELECT id, url, title, note, category_id, created_at, due_at, done_at, snoozed_count \
             FROM links WHERE done_at IS NULL ORDER BY due_at ASC",
        )
        .fetch_all(&state.pool)
        .await?,
    };

    let mut due_now = Vec::new();
    let mut upcoming = Vec::new();
    for link in links {
        let category = link.category_id.and_then(|id| cat_map.get(&id).cloned());
        let view = LinkView::from(link, category, now);
        if view.is_overdue {
            due_now.push(view);
        } else {
            upcoming.push(view);
        }
    }

    Ok(HtmlTemplate(IndexTemplate {
        active_nav: "home",
        due_now,
        upcoming,
        categories,
        selected_category_id: filter.unwrap_or(0),
    }))
}

pub async fn done(
    State(state): State<AppState>,
    Query(query): Query<ListQuery>,
) -> Result<HtmlTemplate<DoneTemplate>, AppError> {
    let now = chrono::Utc::now().naive_utc();
    let categories = load_categories_with_counts(&state.pool).await?;
    let cat_map = cat_lookup(&categories);
    let filter = query.category_id();

    let links: Vec<Link> = match filter {
        Some(id) => sqlx::query_as(
            "SELECT id, url, title, note, category_id, created_at, due_at, done_at, snoozed_count \
             FROM links WHERE done_at IS NOT NULL AND category_id = $1 ORDER BY done_at DESC LIMIT 200",
        )
        .bind(id)
        .fetch_all(&state.pool)
        .await?,
        None => sqlx::query_as(
            "SELECT id, url, title, note, category_id, created_at, due_at, done_at, snoozed_count \
             FROM links WHERE done_at IS NOT NULL ORDER BY done_at DESC LIMIT 200",
        )
        .fetch_all(&state.pool)
        .await?,
    };

    let done = links
        .into_iter()
        .map(|l| {
            let category = l.category_id.and_then(|id| cat_map.get(&id).cloned());
            LinkView::from(l, category, now)
        })
        .collect();

    Ok(HtmlTemplate(DoneTemplate {
        active_nav: "done",
        done,
        categories,
        selected_category_id: filter.unwrap_or(0),
    }))
}

pub async fn service_worker() -> Result<Response, AppError> {
    let body = tokio::fs::read_to_string("static/sw.js").await?;
    let mut resp = body.into_response();
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/javascript"),
    );
    resp.headers_mut().insert(
        "Service-Worker-Allowed",
        HeaderValue::from_static("/"),
    );
    Ok(resp)
}

pub async fn manifest() -> Result<Response, AppError> {
    let body = tokio::fs::read_to_string("static/manifest.webmanifest").await?;
    let mut resp = (StatusCode::OK, body).into_response();
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/manifest+json"),
    );
    Ok(resp)
}

async fn load_categories_with_counts(
    pool: &sqlx::PgPool,
) -> anyhow::Result<Vec<CategoryWithCounts>> {
    let rows = sqlx::query_as::<_, CategoryWithCounts>(
        "SELECT c.id, c.name, c.color, \
            (SELECT COUNT(*) FROM links l WHERE l.category_id = c.id AND l.done_at IS NULL) AS active_count, \
            (SELECT COUNT(*) FROM links l WHERE l.category_id = c.id AND l.done_at IS NOT NULL) AS done_count \
         FROM categories c \
         ORDER BY c.name ASC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

fn cat_lookup(cats: &[CategoryWithCounts]) -> std::collections::HashMap<i64, Category> {
    cats.iter()
        .map(|c| {
            (
                c.id,
                Category {
                    id: c.id,
                    name: c.name.clone(),
                    color: c.color.clone(),
                },
            )
        })
        .collect()
}
