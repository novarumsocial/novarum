// Port of apps/frontend/src/lib/api.ts and anchor.svelte.ts. Eden's `anchor.client.a.b({ id }).c.post()`
// is `api::post(&format!("/a/b/{id}/c"), &body)` here. The session cookie lives in a persisted jar,
// standing in for the browser's `credentials: 'include'`.
use std::{
    fs,
    io::BufReader,
    sync::{Arc, LazyLock, RwLock},
};

use reqwest::{Method, StatusCode};
use reqwest_cookie_store::{CookieStore, CookieStoreMutex};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;

use crate::{runtime, storage};

const HOME_SERVER_KEY: &str = "novarum:home-server";
const BASE_URL_KEY: &str = "novarum:anchor-base-url";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorInfo {
    pub max_file_size: f64,
    #[serde(default = "default_max_group_members")]
    pub max_group_members: u32,
    pub homeserver: String,
    pub base_url: String,
    pub version: Option<String>,
}

fn default_max_group_members() -> u32 {
    30
}

#[derive(Debug, Clone)]
pub struct AnchorState {
    pub home_server: String,
    pub base_url: String,
    pub max_file_size: f64,
    pub max_group_members: u32,
}

static ANCHOR: LazyLock<RwLock<AnchorState>> = LazyLock::new(|| {
    let home_server = storage::get::<String>(HOME_SERVER_KEY).unwrap_or_else(|| "novarum.me".into());
    let base_url = storage::get::<String>(BASE_URL_KEY)
        .unwrap_or_else(|| anchor_url_from_home_server(&home_server));
    RwLock::new(AnchorState { home_server, base_url, max_file_size: 10.0, max_group_members: 30 })
});

fn cookie_path() -> std::path::PathBuf {
    storage::data_dir().join("cookies.json")
}

static JAR: LazyLock<Arc<CookieStoreMutex>> = LazyLock::new(|| {
    let store = fs::File::open(cookie_path())
        .ok()
        .and_then(|file| cookie_store::serde::json::load(BufReader::new(file)).ok())
        .unwrap_or_else(|| CookieStore::new(None));
    Arc::new(CookieStoreMutex::new(store))
});

static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .cookie_provider(JAR.clone())
        .user_agent(concat!("Novarum-Desktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("http client")
});

pub fn http() -> &'static reqwest::Client {
    &HTTP
}

fn save_cookies() {
    let Ok(store) = JAR.lock() else { return };
    let mut bytes = Vec::new();
    // the session cookie has no expiry of its own on some servers; keep it like a browser profile would
    if cookie_store::serde::json::save_incl_expired_and_nonpersistent(&store, &mut bytes).is_ok() {
        let _ = fs::write(cookie_path(), bytes);
    }
}

/// The `Cookie` header for `url`, for requests made outside reqwest (the websocket).
pub fn cookie_header(url: &url::Url) -> Option<String> {
    let store = JAR.lock().ok()?;
    let pairs: Vec<String> = store
        .get_request_values(url)
        .map(|(name, value)| format!("{name}={value}"))
        .collect();
    (!pairs.is_empty()).then(|| pairs.join("; "))
}

pub fn anchor() -> AnchorState {
    ANCHOR.read().unwrap().clone()
}

pub fn base_url() -> String {
    ANCHOR.read().unwrap().base_url.clone()
}

pub fn normalize_home_server(home_server_url: &str) -> String {
    let url = home_server_url.trim().trim_end_matches('/');
    if url.starts_with("http://") || url.starts_with("https://") {
        if let Ok(parsed) = url::Url::parse(url) {
            let host = parsed.host_str().unwrap_or_default();
            return match parsed.port() {
                Some(port) => format!("{host}:{port}"),
                None => host.to_string(),
            };
        }
    }
    url.to_string()
}

pub fn anchor_url_from_home_server(home_server_url: &str) -> String {
    let url = home_server_url.trim().trim_end_matches('/');
    if url.starts_with("http://") || url.starts_with("https://") {
        return url.into();
    }
    if url.starts_with("localhost") || url.starts_with("127.0.0.1") || url.starts_with("[::1]") {
        return format!("http://{url}");
    }
    format!("https://{url}")
}

pub async fn get_anchor_info(home_server_url: String) -> Result<AnchorInfo, String> {
    runtime::io(async move {
        let home_server = normalize_home_server(&home_server_url);
        let discovery = format!("{}/.well-known/anchor/info", anchor_url_from_home_server(&home_server_url));
        let response = HTTP.get(&discovery).send().await.map_err(|_| {
            format!("Could not reach {home_server}. Check the server address and try again.")
        })?;
        if !response.status().is_success() {
            return Err(format!(
                "{home_server} returned {} while looking for its Anchor server information.",
                response.status().as_u16()
            ));
        }
        let info: AnchorInfo = response
            .json()
            .await
            .map_err(|_| format!("{home_server} returned invalid Anchor server information."))?;
        if info.homeserver != home_server {
            return Err(format!(
                "The server identified itself as {}, not {home_server}. Check the server address.",
                info.homeserver
            ));
        }
        Ok(info)
    })
    .await
}

pub async fn set_home_server(home_server: &str) -> Result<(), String> {
    let normalized = normalize_home_server(home_server);
    let info = get_anchor_info(normalized.clone()).await?;
    let mut anchor = ANCHOR.write().unwrap();
    anchor.home_server = normalized.clone();
    anchor.base_url = info.base_url.trim_end_matches('/').into();
    anchor.max_file_size = info.max_file_size;
    anchor.max_group_members = info.max_group_members;
    storage::set(HOME_SERVER_KEY, &normalized);
    storage::set(BASE_URL_KEY, &anchor.base_url);
    Ok(())
}

/// Like the web app's constructor: refresh the cached info, keep it when offline.
pub async fn refresh_info() {
    let home_server = anchor().home_server;
    if let Ok(info) = get_anchor_info(home_server).await {
        let mut anchor = ANCHOR.write().unwrap();
        anchor.base_url = info.base_url.trim_end_matches('/').into();
        anchor.max_file_size = info.max_file_size;
        anchor.max_group_members = info.max_group_members;
    }
}

#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: u16,
    pub message: String,
    /// The raw error body, for callers that look at more than the message.
    pub body: Value,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// session.svelte.ts's `getErrorMessage`: a string, `{ error }`, or `{ message }`.
pub fn error_message(body: &Value, fallback: &str) -> String {
    match body {
        Value::String(text) if !text.is_empty() => text.clone(),
        Value::Object(map) => map
            .get("error")
            .or_else(|| map.get("message"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| fallback.into()),
        _ => fallback.into(),
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

async fn send(request: reqwest::RequestBuilder) -> ApiResult<Value> {
    let response = request.send().await.map_err(|error| ApiError {
        status: 0,
        message: if error.is_connect() || error.is_timeout() {
            "Could not reach the server. Check your connection and try again.".into()
        } else {
            error.to_string()
        },
        body: Value::Null,
    })?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    save_cookies();
    let body = serde_json::from_str(&text).unwrap_or(Value::String(text));
    if status.is_success() {
        Ok(body)
    } else {
        let fallback = status.canonical_reason().unwrap_or("Request failed");
        Err(ApiError { status: status.as_u16(), message: error_message(&body, fallback), body })
    }
}

fn decode<T: DeserializeOwned>(value: Value) -> ApiResult<T> {
    serde_json::from_value(value.clone()).map_err(|error| ApiError {
        status: 200,
        message: format!("Unexpected response from the server: {error}"),
        body: value,
    })
}

/// A JSON request to Anchor. `path` starts with `/`; `query` is appended for GETs.
pub async fn request<T: DeserializeOwned + Send + 'static>(
    method: Method,
    path: impl Into<String>,
    query: Vec<(String, String)>,
    body: Option<Value>,
) -> ApiResult<T> {
    let url = format!("{}{}", base_url(), path.into());
    runtime::io(async move {
        let mut builder = HTTP.request(method, &url).query(&query);
        if let Some(body) = body {
            builder = builder.json(&body);
        }
        decode(send(builder).await?)
    })
    .await
}

pub async fn get<T: DeserializeOwned + Send + 'static>(path: impl Into<String>) -> ApiResult<T> {
    request(Method::GET, path, vec![], None).await
}

pub async fn get_query<T: DeserializeOwned + Send + 'static>(
    path: impl Into<String>,
    query: &[(&str, String)],
) -> ApiResult<T> {
    let query = query.iter().map(|(k, v)| (k.to_string(), v.clone())).collect();
    request(Method::GET, path, query, None).await
}

pub async fn post<T: DeserializeOwned + Send + 'static>(
    path: impl Into<String>,
    body: impl Serialize,
) -> ApiResult<T> {
    request(Method::POST, path, vec![], Some(serde_json::to_value(body).unwrap_or_default())).await
}

pub async fn patch<T: DeserializeOwned + Send + 'static>(
    path: impl Into<String>,
    body: impl Serialize,
) -> ApiResult<T> {
    request(Method::PATCH, path, vec![], Some(serde_json::to_value(body).unwrap_or_default())).await
}

pub async fn put<T: DeserializeOwned + Send + 'static>(
    path: impl Into<String>,
    body: impl Serialize,
) -> ApiResult<T> {
    request(Method::PUT, path, vec![], Some(serde_json::to_value(body).unwrap_or_default())).await
}

pub async fn delete<T: DeserializeOwned + Send + 'static>(path: impl Into<String>) -> ApiResult<T> {
    request(Method::DELETE, path, vec![], None).await
}

pub async fn delete_with<T: DeserializeOwned + Send + 'static>(
    path: impl Into<String>,
    body: impl Serialize,
) -> ApiResult<T> {
    request(Method::DELETE, path, vec![], Some(serde_json::to_value(body).unwrap_or_default())).await
}

/// A multipart POST with one file in `field`, like Eden's `{ icon: File }` bodies.
pub async fn post_file<T: DeserializeOwned + Send + 'static>(
    path: impl Into<String>,
    field: &'static str,
    file: crate::state::chat::UploadFile,
) -> ApiResult<T> {
    let url = format!("{}{}", base_url(), path.into());
    runtime::io(async move {
        let part = reqwest::multipart::Part::bytes(file.bytes)
            .file_name(file.name)
            .mime_str(&file.content_type)
            .map_err(|error| ApiError { status: 0, message: error.to_string(), body: Value::Null })?;
        let form = reqwest::multipart::Form::new().part(field, part);
        decode(send(HTTP.post(&url).multipart(form)).await?)
    })
    .await
}

/// PUTs raw bytes to a presigned upload url (no cookies needed, but harmless).
pub async fn upload_bytes(url: String, content_type: String, bytes: Vec<u8>) -> Result<(), String> {
    runtime::io(async move {
        let response = HTTP
            .put(&url)
            .header("content-type", content_type)
            .body(bytes)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        if response.status().is_success() { Ok(()) } else { Err(format!("Upload failed ({})", response.status())) }
    })
    .await
}

/// Downloads bytes (images, attachments) with the session cookie.
pub async fn fetch_bytes(url: String) -> Result<Vec<u8>, String> {
    runtime::io(async move {
        let response = HTTP.get(&url).send().await.map_err(|error| error.to_string())?;
        if response.status() != StatusCode::OK {
            return Err(format!("{}", response.status()));
        }
        response.bytes().await.map(|bytes| bytes.to_vec()).map_err(|error| error.to_string())
    })
    .await
}

/// Ignores the response body: for routes whose callers only care that it worked.
pub type Ignored = serde::de::IgnoredAny;
