// SvelteKit's routing, kept as paths so `goto('/guilds/...')` ports one to one.
use std::collections::HashMap;

use gpui_kit::*;

#[derive(Debug, Clone, PartialEq)]
pub enum ChatRoute {
    Home,
    Developers { bot_id: Option<String> },
    Dms { channel_id: Option<String>, message_id: Option<String> },
    Guild { server_id: Option<String>, channel_id: Option<String>, message_id: Option<String> },
}

#[derive(Debug, Clone, PartialEq)]
pub enum Page {
    Login,
    Register,
    ResetPassword,
    Authorize,
    Invite(String),
    Updater,
    Guilds(ChatRoute),
}

pub struct Router {
    pub path: String,
    pub query: HashMap<String, String>,
}

struct GlobalRouter(Entity<Router>);
impl Global for GlobalRouter {}

pub fn init(cx: &mut App) {
    let router = cx.new(|_| Router { path: "/guilds".into(), query: HashMap::new() });
    cx.set_global(GlobalRouter(router));
    // debug builds can open straight onto a page, e.g. NOVARUM_START_PATH=/guilds/dms
    #[cfg(debug_assertions)]
    if let Ok(path) = std::env::var("NOVARUM_START_PATH") {
        goto(path, cx);
    }
}

fn decode(part: &str) -> String {
    url::form_urlencoded::parse(format!("x={part}").as_bytes())
        .next()
        .map(|(_, value)| value.into_owned())
        .unwrap_or_else(|| part.into())
}

pub fn encode(part: &str) -> String {
    url::form_urlencoded::byte_serialize(part.as_bytes()).collect::<String>().replace('+', "%20")
}

pub fn parse_chat_route(rest: &str) -> ChatRoute {
    let parts: Vec<String> = rest.split('/').filter(|part| !part.is_empty()).map(decode).collect();
    let get = |index: usize| parts.get(index).cloned();
    match parts.first().map(String::as_str) {
        None => ChatRoute::Home,
        Some("developers") => ChatRoute::Developers { bot_id: get(1) },
        Some("dms") => ChatRoute::Dms { channel_id: get(1), message_id: get(2) },
        Some(_) => ChatRoute::Guild { server_id: get(0), channel_id: get(1), message_id: get(2) },
    }
}

impl Router {
    pub fn global(cx: &App) -> Entity<Self> {
        cx.global::<GlobalRouter>().0.clone()
    }

    pub fn page(&self) -> Page {
        let path = self.path.trim_end_matches('/');
        match path {
            "/login" => Page::Login,
            "/register" => Page::Register,
            "/reset-password" => Page::ResetPassword,
            "/authorize" => Page::Authorize,
            "/updater" => Page::Updater,
            _ if path.starts_with("/i/") => Page::Invite(decode(&path[3..])),
            _ => Page::Guilds(parse_chat_route(path.strip_prefix("/guilds").unwrap_or(""))),
        }
    }

    pub fn route(cx: &App) -> ChatRoute {
        match Self::global(cx).read(cx).page() {
            Page::Guilds(route) => route,
            _ => ChatRoute::Home,
        }
    }

    pub fn param(&self, key: &str) -> Option<String> {
        self.query.get(key).cloned()
    }
}

/// `goto(url)`. Accepts a query string, like `/login?redirect=/guilds`.
pub fn goto(url: impl AsRef<str>, cx: &mut App) {
    let url = url.as_ref();
    let (path, query) = url.split_once('?').unwrap_or((url, ""));
    let path = if path.is_empty() || path == "/" { "/guilds" } else { path };
    let query = url::form_urlencoded::parse(query.as_bytes()).into_owned().collect();
    Router::global(cx).update(cx, |router, cx| {
        if router.path != path || router.query != query {
            router.path = path.into();
            router.query = query;
            cx.notify();
        }
    });
}

/// safeRedirect.ts: only same-app paths, never `//host` or a full url.
pub fn safe_redirect(target: Option<&str>) -> String {
    match target {
        Some(target) if target.starts_with('/') && !target.starts_with("//") && !target.starts_with("/\\") => {
            target.into()
        }
        _ => "/guilds".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::{ChatRoute, parse_chat_route, safe_redirect};

    #[test]
    fn parses_chat_routes() {
        assert_eq!(parse_chat_route(""), ChatRoute::Home);
        assert_eq!(
            parse_chat_route("/dms/abc"),
            ChatRoute::Dms { channel_id: Some("abc".into()), message_id: None }
        );
        assert_eq!(
            parse_chat_route("/g%3Ax/c/m"),
            ChatRoute::Guild {
                server_id: Some("g:x".into()),
                channel_id: Some("c".into()),
                message_id: Some("m".into())
            }
        );
    }

    #[test]
    fn rejects_unsafe_redirects() {
        assert_eq!(safe_redirect(Some("//evil.com")), "/guilds");
        assert_eq!(safe_redirect(Some("https://evil.com")), "/guilds");
        assert_eq!(safe_redirect(Some("/guilds/dms")), "/guilds/dms");
    }
}
