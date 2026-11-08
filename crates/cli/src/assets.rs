//! The dashboard, built into the program so a release is one file. A build made without it (a development build)
//! serves `dashboard.assets_path` from disk instead.
use axum::{
    body::Body,
    http::{HeaderValue, StatusCode, Uri, header},
    response::{IntoResponse, Response},
};

#[derive(rust_embed::Embed)]
#[folder = "../../dashboard/dist"]
#[allow_missing = true]
struct Dashboard;

/// Whether this build carries the dashboard. In a debug build rust-embed reads the folder at run time, so this is
/// also true there once the dashboard has been built.
pub fn embedded() -> bool {
    Dashboard::get("index.html").is_some()
}

/// One dashboard file, or index.html for any path the single-page app routes itself.
pub async fn serve(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let (file, name) = match Dashboard::get(path).filter(|_| !path.is_empty()) {
        Some(f) => (f, path),
        None => match Dashboard::get("index.html") {
            Some(f) => (f, "index.html"),
            None => {
                return (
                    StatusCode::NOT_FOUND,
                    "This build has no dashboard. Build it with `npm run build` in dashboard/.",
                )
                    .into_response();
            }
        },
    };
    let mime = file.metadata.mimetype().to_owned();
    // Hashed asset names never change content, so they can be kept; index.html must be fetched fresh after an update.
    let cache = if name.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let mut res = Response::new(Body::from(file.data.into_owned()));
    let h = res.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&mime) {
        h.insert(header::CONTENT_TYPE, v);
    }
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    res
}
