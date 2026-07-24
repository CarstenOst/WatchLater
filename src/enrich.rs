use anyhow::Result;
use sqlx::PgPool;

pub async fn fetch_and_store_title(
    pool: &PgPool,
    http: &reqwest::Client,
    link_id: i64,
    url: &str,
) -> Result<()> {
    let Some(title) = fetch_title(http, url).await? else {
        return Ok(());
    };
    sqlx::query("UPDATE links SET title = $1 WHERE id = $2 AND (title IS NULL OR title = '')")
        .bind(&title)
        .bind(link_id)
        .execute(pool)
        .await?;
    Ok(())
}

async fn fetch_title(http: &reqwest::Client, url: &str) -> Result<Option<String>> {
    let resp = http.get(url).send().await?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let ct = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    if !ct.starts_with("text/html") && !ct.contains("xhtml") && !ct.is_empty() {
        return Ok(None);
    }
    // Cap at ~256KB to avoid huge pages
    let bytes = resp.bytes().await?;
    let slice = if bytes.len() > 256 * 1024 {
        &bytes[..256 * 1024]
    } else {
        &bytes[..]
    };
    let html = String::from_utf8_lossy(slice);
    let raw = extract_og_title(&html).or_else(|| extract_page_title(&html));
    Ok(raw.map(|t| clean_title(url, t)).filter(|t| !t.is_empty()))
}

fn extract_og_title(html: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let mut cursor = 0;
    while let Some(rel) = lower[cursor..].find("<meta") {
        let tag_start = cursor + rel;
        let tag_end = match lower[tag_start..].find('>') {
            Some(end) => tag_start + end + 1,
            None => break,
        };
        let tag = &html[tag_start..tag_end];
        let lower_tag = &lower[tag_start..tag_end];
        if lower_tag.contains("og:title") {
            if let Some(v) = extract_attr(tag, "content") {
                let decoded = decode_entities(v.trim());
                if !decoded.is_empty() {
                    return Some(truncate(&decoded, 300));
                }
            }
        }
        cursor = tag_end;
    }
    None
}

fn extract_page_title(html: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let start_tag = lower.find("<title")?;
    let after = &html[start_tag..];
    let gt = after.find('>')?;
    let rest = &after[gt + 1..];
    let end = rest.to_lowercase().find("</title>")?;
    let raw = &rest[..end];
    let decoded = decode_entities(raw.trim());
    if decoded.is_empty() {
        None
    } else {
        Some(truncate(&decoded, 300))
    }
}

fn extract_attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_lowercase();
    let lower_name = name.to_lowercase();
    for quote in ['"', '\''] {
        let needle = format!("{}={}", lower_name, quote);
        if let Some(i) = lower.find(&needle) {
            let value_start = i + needle.len();
            if let Some(end) = tag[value_start..].find(quote) {
                return Some(tag[value_start..value_start + end].to_string());
            }
        }
    }
    None
}

fn clean_title(url: &str, title: String) -> String {
    let host = url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_lowercase()))
        .unwrap_or_default();

    let mut t = title;
    if host.ends_with("youtube.com") || host == "youtu.be" {
        t = strip_suffix_ci(&t, " - YouTube").to_string();
    } else if host.ends_with("reddit.com") {
        if let Some(i) = t.rfind(" : r/") {
            t = t[..i].to_string();
        } else if let Some(i) = t.to_lowercase().rfind(" - reddit") {
            t = t[..i].to_string();
        }
    }
    t.trim().to_string()
}

fn strip_suffix_ci<'a>(s: &'a str, suffix: &str) -> &'a str {
    if s.len() >= suffix.len() {
        let tail = &s[s.len() - suffix.len()..];
        if tail.eq_ignore_ascii_case(suffix) {
            return &s[..s.len() - suffix.len()];
        }
    }
    s
}

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max).collect();
        out.push('…');
        out
    }
}
