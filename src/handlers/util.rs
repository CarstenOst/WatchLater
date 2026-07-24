use axum::http::HeaderMap;
use axum::http::header::REFERER;
use axum::response::Redirect;
use sqlx::PgPool;

pub async fn smart_redirect(pool: &PgPool, headers: &HeaderMap) -> Redirect {
    let (path, category) = parse_referer(headers);

    let Some(cat_id) = category else {
        return Redirect::to(&path);
    };

    let count: i64 = if path == "/done" {
        sqlx::query_scalar(
            "SELECT COUNT(*) FROM links WHERE category_id = $1 AND done_at IS NOT NULL",
        )
        .bind(cat_id)
        .fetch_one(pool)
        .await
        .unwrap_or(0)
    } else {
        sqlx::query_scalar(
            "SELECT COUNT(*) FROM links WHERE category_id = $1 AND done_at IS NULL",
        )
        .bind(cat_id)
        .fetch_one(pool)
        .await
        .unwrap_or(0)
    };

    if count > 0 {
        Redirect::to(&format!("{}?category={}", path, cat_id))
    } else {
        Redirect::to(&path)
    }
}

fn parse_referer(headers: &HeaderMap) -> (String, Option<i64>) {
    let Some(ref_str) = headers.get(REFERER).and_then(|v| v.to_str().ok()) else {
        return ("/".to_string(), None);
    };
    let Ok(url) = url::Url::parse(ref_str) else {
        return ("/".to_string(), None);
    };

    let path = if url.path() == "/done" { "/done" } else { "/" };
    let category = url
        .query_pairs()
        .find(|(k, _)| k == "category")
        .and_then(|(_, v)| v.parse::<i64>().ok())
        .filter(|&id| id > 0);

    (path.to_string(), category)
}
