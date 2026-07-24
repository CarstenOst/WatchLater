use askama::Template;

use crate::models::{CategoryWithCounts, LinkView};

#[derive(Template)]
#[template(path = "index.html")]
pub struct IndexTemplate {
    pub active_nav: &'static str,
    pub due_now: Vec<LinkView>,
    pub upcoming: Vec<LinkView>,
    pub categories: Vec<CategoryWithCounts>,
    pub selected_category_id: i64,
}

#[derive(Template)]
#[template(path = "done.html")]
pub struct DoneTemplate {
    pub active_nav: &'static str,
    pub done: Vec<LinkView>,
    pub categories: Vec<CategoryWithCounts>,
    pub selected_category_id: i64,
}
