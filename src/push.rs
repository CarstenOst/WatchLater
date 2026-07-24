use anyhow::{Context, Result};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sqlx::PgPool;
use web_push::{
    ContentEncoding, SubscriptionInfo, SubscriptionKeys, VapidSignatureBuilder,
    WebPushClient, WebPushMessageBuilder,
};

#[derive(Clone)]
pub struct VapidKeys {
    pub private_pem: String,
    pub public_b64: String,
    pub subject: String,
}

impl VapidKeys {
    pub fn load(
        private_pem: Option<String>,
        public_b64: Option<String>,
        subject: String,
    ) -> Option<Self> {
        let private_pem = private_pem?;
        let public_b64 = public_b64?;
        Some(Self {
            private_pem,
            public_b64,
            subject,
        })
    }
}

pub async fn send_notification(
    pool: &PgPool,
    vapid: &VapidKeys,
    title: &str,
    body: &str,
    url: &str,
) -> Result<()> {
    let subs: Vec<(String, String, String)> =
        sqlx::query_as("SELECT endpoint, p256dh, auth FROM push_subscriptions")
            .fetch_all(pool)
            .await?;
    if subs.is_empty() {
        return Ok(());
    }

    let client = web_push::IsahcWebPushClient::new()
        .context("failed to build web-push client")?;
    let payload = serde_json::json!({
        "title": title,
        "body": body,
        "url": url,
    })
    .to_string();

    for (endpoint, p256dh, auth) in subs {
        let info = SubscriptionInfo {
            endpoint: endpoint.clone(),
            keys: SubscriptionKeys { p256dh, auth },
        };
        let sig = match VapidSignatureBuilder::from_pem(vapid.private_pem.as_bytes(), &info) {
            Ok(mut b) => {
                b.add_claim("sub", vapid.subject.clone());
                match b.build() {
                    Ok(s) => s,
                    Err(e) => {
                        tracing::warn!("vapid build failed: {:?}", e);
                        continue;
                    }
                }
            }
            Err(e) => {
                tracing::warn!("vapid pem load failed: {:?}", e);
                continue;
            }
        };
        let mut builder = WebPushMessageBuilder::new(&info);
        builder.set_payload(ContentEncoding::Aes128Gcm, payload.as_bytes());
        builder.set_vapid_signature(sig);
        let msg = match builder.build() {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!("message build failed: {:?}", e);
                continue;
            }
        };
        match client.send(msg).await {
            Ok(_) => {}
            Err(web_push::WebPushError::EndpointNotValid)
            | Err(web_push::WebPushError::EndpointNotFound) => {
                let _ = sqlx::query("DELETE FROM push_subscriptions WHERE endpoint = $1")
                    .bind(&endpoint)
                    .execute(pool)
                    .await;
            }
            Err(e) => {
                tracing::warn!("push send error for {}: {:?}", endpoint, e);
            }
        }
    }
    Ok(())
}

#[allow(dead_code)]
pub fn decode_public_key(b64: &str) -> Result<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(b64.trim())
        .context("invalid VAPID public key base64url")
}
