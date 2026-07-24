use anyhow::Result;

pub struct Config {
    pub port: u16,
    pub db_url: String,
    pub vapid_private_pem: Option<String>,
    pub vapid_public_b64: Option<String>,
    pub vapid_subject: String,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        Ok(Self {
            port: std::env::var("PORT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(3420),
            db_url: std::env::var("DATABASE_URL").unwrap_or_else(|_| {
                "postgres://watchlater:watchlater@localhost:5433/watchlater".to_string()
            }),
            vapid_private_pem: std::env::var("VAPID_PRIVATE_KEY").ok(),
            vapid_public_b64: std::env::var("VAPID_PUBLIC_KEY").ok(),
            vapid_subject: std::env::var("VAPID_SUBJECT")
                .unwrap_or_else(|_| "mailto:aquulsmurf@gmail.com".to_string()),
        })
    }
}
