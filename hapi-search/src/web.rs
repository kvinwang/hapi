use axum::{
    extract::{Query, State},
    http::{header, StatusCode},
    response::{Html, IntoResponse, Json, Response},
    routing::get,
    Router,
};
use serde::Deserialize;
use std::sync::Arc;
use tower_http::cors::CorsLayer;

use crate::search::SearchService;
use crate::indexer::Indexer;

const INDEX_HTML: &str = include_str!("../static/index.html");
const STYLE_CSS: &str = include_str!("../static/style.css");
const APP_JS: &str = include_str!("../static/app.js");

pub struct AppState {
    pub search: SearchService,
    pub indexer: Indexer,
}

#[derive(Deserialize)]
pub struct SearchQuery {
    q: String,
    #[serde(default = "default_limit")]
    limit: usize,
    #[serde(default)]
    offset: usize,
}

fn default_limit() -> usize {
    20
}

pub fn create_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", get(handle_index))
        .route("/style.css", get(handle_css))
        .route("/app.js", get(handle_js))
        .route("/api/search", get(handle_search))
        .route("/api/stats", get(handle_stats))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

async fn handle_index() -> Html<&'static str> {
    Html(INDEX_HTML)
}

async fn handle_css() -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/css")],
        STYLE_CSS,
    )
        .into_response()
}

async fn handle_js() -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/javascript")],
        APP_JS,
    )
        .into_response()
}

async fn handle_search(
    State(state): State<Arc<AppState>>,
    Query(params): Query<SearchQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let limit = params.limit.min(100);

    match state.search.search(&params.q, limit, params.offset).await {
        Ok(result) => Ok(Json(serde_json::to_value(result).unwrap())),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

async fn handle_stats(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    match state.indexer.get_stats().await {
        Ok(stats) => Ok(Json(serde_json::json!({
            "documents": stats.number_of_documents,
        }))),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}
