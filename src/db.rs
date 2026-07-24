use anyhow::Result;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use std::time::Duration;

pub async fn init(url: &str) -> Result<PgPool> {
    let pool = connect_with_retry(url).await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}

async fn connect_with_retry(url: &str) -> Result<PgPool> {
    let mut attempts = 0;
    loop {
        match PgPoolOptions::new()
            .max_connections(8)
            .acquire_timeout(Duration::from_secs(3))
            .connect(url)
            .await
        {
            Ok(pool) => return Ok(pool),
            Err(e) if attempts < 15 => {
                tracing::warn!("postgres connect failed ({e}), retry {attempts}/15 in 1s");
                attempts += 1;
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            Err(e) => return Err(e.into()),
        }
    }
}
