use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct Category {
    pub id: i64,
    pub name: String,
    pub color: Option<String>,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct CategoryWithCounts {
    pub id: i64,
    pub name: String,
    pub color: Option<String>,
    pub active_count: i64,
    pub done_count: i64,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct Link {
    pub id: i64,
    pub url: String,
    pub title: Option<String>,
    pub note: Option<String>,
    pub category_id: Option<i64>,
    pub created_at: NaiveDateTime,
    pub due_at: NaiveDateTime,
    pub done_at: Option<NaiveDateTime>,
    pub snoozed_count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct LinkView {
    pub id: i64,
    pub url: String,
    pub title: String,
    pub note: Option<String>,
    pub category: Option<Category>,
    pub due_iso: String,
    pub due_human: String,
    pub is_overdue: bool,
    pub is_done: bool,
    pub snoozed_count: i64,
}

impl LinkView {
    pub fn from(link: Link, category: Option<Category>, now: NaiveDateTime) -> Self {
        let is_overdue = link.done_at.is_none() && link.due_at <= now;
        let is_done = link.done_at.is_some();
        let title = link
            .title
            .clone()
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| fallback_title(&link.url));
        let due_iso = link.due_at.and_utc().to_rfc3339();
        let due_human = human_delta(now, link.due_at);
        Self {
            id: link.id,
            url: link.url,
            title,
            note: link.note,
            category,
            due_iso,
            due_human,
            is_overdue,
            is_done,
            snoozed_count: link.snoozed_count,
        }
    }
}

fn fallback_title(url: &str) -> String {
    if url.len() <= 20 {
        return url.to_string();
    }
    domain_label(url).unwrap_or_else(|| url.to_string())
}

fn domain_label(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let host = parsed.host_str()?;
    let host = host.strip_prefix("www.").unwrap_or(host);
    let labels: Vec<&str> = host.split('.').collect();
    match labels.len() {
        0 => None,
        1 => Some(labels[0].to_string()),
        _ => Some(labels[labels.len() - 2].to_string()),
    }
}

fn human_delta(now: NaiveDateTime, target: NaiveDateTime) -> String {
    let delta = target.signed_duration_since(now);
    let secs = delta.num_seconds();
    if secs.abs() < 60 {
        return "now".into();
    }
    let mins = delta.num_minutes();
    if mins.abs() < 60 {
        return if mins >= 0 {
            format!("in {}m", mins)
        } else {
            format!("{}m ago", -mins)
        };
    }
    let hours = delta.num_hours();
    if hours.abs() < 48 {
        return if hours >= 0 {
            format!("in {}h", hours)
        } else {
            format!("{}h ago", -hours)
        };
    }
    let days = delta.num_days();
    if days >= 0 {
        format!("in {}d", days)
    } else {
        format!("{}d ago", -days)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub enum RemindIn {
    #[serde(rename = "8h")]
    EightHours,
    #[serde(rename = "24h")]
    TwentyFourHours,
    #[serde(rename = "1w")]
    OneWeek,
    #[serde(rename = "custom")]
    Custom,
}

impl RemindIn {
    pub fn resolve(&self, now: NaiveDateTime, custom: Option<NaiveDateTime>) -> NaiveDateTime {
        match self {
            RemindIn::EightHours => now + chrono::Duration::hours(8),
            RemindIn::TwentyFourHours => now + chrono::Duration::hours(24),
            RemindIn::OneWeek => now + chrono::Duration::weeks(1),
            RemindIn::Custom => custom.unwrap_or(now + chrono::Duration::hours(24)),
        }
    }
}
