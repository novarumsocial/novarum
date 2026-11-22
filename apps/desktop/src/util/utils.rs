// Port of apps/frontend/src/lib/utils.ts (the parts that don't touch the DOM).
use std::sync::LazyLock;

use regex::Regex;

pub static URL_PATTERN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"https?://[^\s]+").unwrap());

pub fn is_url(value: &str) -> bool {
    static FULL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^https?://[^\s]+$").unwrap());
    FULL.is_match(value)
}

/// "@everyone", but not a handle like @everyone:example.com. The server pings every guild member
/// for it without listing them in pingedHandles, so clients look for it in the content.
pub fn mentions_everyone(content: Option<&str>) -> bool {
    let text = URL_PATTERN.replace_all(content.unwrap_or_default(), "");
    let chars: Vec<char> = text.chars().collect();
    let target: Vec<char> = "@everyone".chars().collect();
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    (0..chars.len()).any(|start| {
        let end = start + target.len();
        chars.get(start..end) == Some(&target[..])
            && !start
                .checked_sub(1)
                .is_some_and(|before| word(chars[before]) || chars[before] == '.')
            && !chars.get(end).is_some_and(|&after| {
                word(after)
                    || after == ':'
                    || (after == '.'
                        && chars
                            .get(end + 1)
                            .is_some_and(|c| c.is_ascii_alphanumeric()))
            })
    })
}

pub fn format_bytes(bytes: f64) -> String {
    if bytes < 1024.0 {
        format!("{bytes} B")
    } else if bytes < 1024.0 * 1024.0 {
        format!("{:.1} KB", bytes / 1024.0)
    } else {
        format!("{:.1} MB", bytes / (1024.0 * 1024.0))
    }
}

#[cfg(test)]
mod tests {
    use super::{format_bytes, is_url, mentions_everyone};

    #[test]
    fn finds_everyone_but_not_handles_or_urls() {
        assert!(mentions_everyone(Some("hey @everyone!")));
        assert!(mentions_everyone(Some("@everyone. hi")));
        assert!(!mentions_everyone(Some("@everyone:example.com")));
        assert!(!mentions_everyone(Some("@everyone.example.com")));
        assert!(!mentions_everyone(Some("me@everyone")));
        assert!(!mentions_everyone(Some("https://x.com/@everyone")));
        assert!(!mentions_everyone(None));
    }

    #[test]
    fn formats_bytes_and_urls() {
        assert_eq!(format_bytes(512.0), "512 B");
        assert_eq!(format_bytes(2048.0), "2.0 KB");
        assert_eq!(format_bytes(3.5 * 1024.0 * 1024.0), "3.5 MB");
        assert!(is_url("https://novarum.me/x"));
        assert!(!is_url("see https://novarum.me"));
    }
}
