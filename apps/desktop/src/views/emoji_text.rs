// Port of apps/frontend/src/lib/components/emoji-text.svelte: plain text with links, mentions and
// emoji drawn as the homeserver's images. Also the rich text surface markdown.rs draws into: a
// paragraph is a list of styled spans, drawn as one wrapping `StyledText` (links and spoilers
// clickable), or as a flow of words when it holds emoji images, which `StyledText` can't inline.
use std::{collections::HashSet, sync::LazyLock};

use gpui_kit::component::{ActiveTheme, tooltip::Tooltip};
use regex::Regex;

use crate::prelude::*;

use crate::{
    desktop,
    state::{realtime::Realtime, session::Session},
    util::utils::URL_PATTERN,
};

#[derive(Debug, Clone, PartialEq)]
pub enum PartKind {
    Text,
    Url,
    Mention,
    /// an emoji grapheme and its unicode key (`1F44B-1F3FD`), as the emoji images are keyed
    Emoji(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Part {
    pub text: String,
    pub kind: PartKind,
}

static HANDLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"@[a-zA-Z0-9._]+:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?").unwrap()
});

fn handle_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '.' || c == '_'
}

/// `@user:server` handles and `@everyone`, with the web's lookbehind/lookahead rules: byte ranges.
fn mentions(text: &str) -> Vec<(usize, usize)> {
    let preceded = |start: usize| text[..start].chars().next_back().is_some_and(handle_char);
    let mut found: Vec<(usize, usize)> = HANDLE
        .find_iter(text)
        .filter(|found| !preceded(found.start()))
        .map(|found| (found.start(), found.end()))
        .collect();
    for (start, _) in text.match_indices("@everyone") {
        let end = start + "@everyone".len();
        let mut after = text[end..].chars();
        let next = after.next();
        let blocked = next.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_' || c == ':')
            || (next == Some('.') && after.next().is_some_and(|c| c.is_ascii_alphanumeric()));
        if !preceded(start) && !blocked && !found.iter().any(|(s, e)| start < *e && end > *s) {
            found.push((start, end));
        }
    }
    found.sort();
    found
}

/// The `@user:server` handles written in `content`, for "does this message mention me".
pub fn handles(content: &str) -> Vec<String> {
    mentions(content)
        .into_iter()
        .map(|(start, end)| content[start..end].to_string())
        .filter(|handle| handle != "@everyone")
        .collect()
}

fn pictographic(c: char) -> bool {
    matches!(c as u32,
        0x1F000..=0x1FAFF | 0x2600..=0x27BF | 0x2300..=0x23FF | 0x2B00..=0x2BFF | 0x2190..=0x21FF
        | 0x25A0..=0x25FF | 0x2900..=0x297F | 0x3030 | 0x303D | 0x3297 | 0x3299 | 0xA9 | 0xAE
        | 0x203C | 0x2049 | 0x2122 | 0x2139 | 0x24C2)
}

fn regional(c: char) -> bool {
    ('\u{1F1E6}'..='\u{1F1FF}').contains(&c)
}

fn joins(c: char) -> bool {
    matches!(c, '\u{FE0F}' | '\u{FE0E}' | '\u{20E3}' | '\u{1F3FB}'..='\u{1F3FF}' | '\u{E0020}'..='\u{E007F}')
}

/// The emoji grapheme starting at `chars[at]`, if one does: how many chars it spans.
fn emoji_at(chars: &[char], at: usize) -> Option<usize> {
    let c = chars[at];
    if regional(c) {
        return Some(if chars.get(at + 1).copied().is_some_and(regional) {
            2
        } else {
            1
        });
    }
    // keycaps: 1️⃣ is `1`, an optional VS16 and the enclosing keycap
    if c.is_ascii_digit() || c == '#' || c == '*' {
        let skip = usize::from(chars.get(at + 1) == Some(&'\u{FE0F}'));
        return (chars.get(at + 1 + skip) == Some(&'\u{20E3}')).then_some(2 + skip);
    }
    if !pictographic(c) {
        return None;
    }
    let mut end = at + 1;
    loop {
        while chars.get(end).copied().is_some_and(joins) {
            end += 1;
        }
        if chars.get(end) == Some(&'\u{200D}')
            && chars.get(end + 1).copied().is_some_and(pictographic)
        {
            end += 2;
        } else {
            return Some(end - at);
        }
    }
}

fn unicode_key(grapheme: &str) -> String {
    grapheme
        .chars()
        .map(|c| format!("{:X}", c as u32))
        .collect::<Vec<_>>()
        .join("-")
}

fn push_text(parts: &mut Vec<Part>, text: &str) {
    let chars: Vec<char> = text.chars().collect();
    let mut run = String::new();
    let mut i = 0;
    while i < chars.len() {
        if let Some(length) = emoji_at(&chars, i) {
            if !run.is_empty() {
                parts.push(Part {
                    text: std::mem::take(&mut run),
                    kind: PartKind::Text,
                });
            }
            let grapheme: String = chars[i..i + length].iter().collect();
            parts.push(Part {
                kind: PartKind::Emoji(unicode_key(&grapheme)),
                text: grapheme,
            });
            i += length;
        } else {
            run.push(chars[i]);
            i += 1;
        }
    }
    if !run.is_empty() {
        parts.push(Part {
            text: run,
            kind: PartKind::Text,
        });
    }
}

fn push_mentions(parts: &mut Vec<Part>, text: &str) {
    let mut last = 0;
    for (start, end) in mentions(text) {
        push_text(parts, &text[last..start]);
        parts.push(Part {
            text: text[start..end].to_string(),
            kind: PartKind::Mention,
        });
        last = end;
    }
    push_text(parts, &text[last..]);
}

/// `content` split like the web component: urls (when `links`), mentions, emoji and text.
pub fn parts(content: &str, links: bool) -> Vec<Part> {
    let mut parts = Vec::new();
    let mut last = 0;
    for found in URL_PATTERN.find_iter(content) {
        if !links {
            continue;
        }
        push_mentions(&mut parts, &content[last..found.start()]);
        parts.push(Part {
            text: found.as_str().to_string(),
            kind: PartKind::Url,
        });
        last = found.end();
    }
    push_mentions(&mut parts, &content[last..]);
    parts
}

// ---- drawing ----

/// How a span of a paragraph looks. Every flag matches one markdown node or emoji-text part.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SpanStyle {
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strike: bool,
    pub code: bool,
    pub link: Option<String>,
    /// `@user:server` or `@everyone`
    pub mention: bool,
    /// which spoiler of the paragraph it belongs to
    pub spoiler: Option<usize>,
    /// an emoji's unicode key, drawn as its image once the homeserver sent one
    pub emoji: Option<String>,
    /// the "(edited)" after a message, with its tooltip
    pub trailing: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Span {
    pub text: String,
    pub style: SpanStyle,
}

/// The emoji-text parts of `text` as spans on top of `style`.
pub fn spans_for(text: &str, links: bool, style: &SpanStyle) -> Vec<Span> {
    parts(text, links)
        .into_iter()
        .map(|part| {
            let mut style = style.clone();
            match part.kind {
                PartKind::Text => {}
                PartKind::Url => {
                    style.link = Some(part.text.clone());
                    style.underline = true;
                }
                PartKind::Mention => style.mention = true,
                PartKind::Emoji(unicode) => style.emoji = Some(unicode),
            }
            Span {
                text: part.text,
                style,
            }
        })
        .collect()
}

/// The paragraph's own text settings: what Tailwind put on the `<p>`.
#[derive(Clone, Copy)]
pub struct TextOptions {
    pub size: Pixels,
    pub weight: FontWeight,
    pub color: Hsla,
    /// one line, cut with an ellipsis (reply previews)
    pub truncate: bool,
}

impl TextOptions {
    pub fn new(size: Pixels, color: Hsla) -> Self {
        Self {
            size,
            weight: FontWeight::NORMAL,
            color,
            truncate: false,
        }
    }
}

struct Look {
    font: Font,
    color: Hsla,
    background: Option<Hsla>,
    underline: bool,
    strike: bool,
}

fn look(
    style: &SpanStyle,
    options: &TextOptions,
    revealed: &HashSet<usize>,
    text: &str,
    cx: &App,
) -> Look {
    let t = theme::tokens(cx);
    let mut font = font(if style.code {
        cx.theme().mono_font_family.clone()
    } else {
        "IBM Plex Sans".into()
    });
    font.weight = if style.bold {
        FontWeight::SEMIBOLD
    } else {
        options.weight
    };
    if style.mention {
        font.weight = FontWeight::MEDIUM;
    }
    if style.italic {
        font.style = FontStyle::Italic;
    }
    let mut look = Look {
        font,
        color: if style.link.is_some() {
            t.link
        } else {
            options.color
        },
        background: None,
        underline: style.underline,
        strike: style.strike,
    };
    if style.code {
        look.background = Some(t.muted);
    }
    if style.mention {
        look.color = t.link;
        look.background = Some(
            t.link
                .opacity(if me_mentioned(text, cx) { 0.25 } else { 0.12 }),
        );
    }
    if style.trailing.is_some() {
        look.color = t.muted_foreground.opacity(0.6);
    }
    if let Some(spoiler) = style.spoiler {
        if revealed.contains(&spoiler) {
            look.background = Some(t.muted_foreground.opacity(0.2));
        } else {
            look.background = Some(t.muted_foreground);
            look.color = t.muted_foreground;
        }
    }
    look
}

fn me_mentioned(text: &str, cx: &App) -> bool {
    text == "@everyone"
        || Session::user(cx)
            .is_some_and(|user| text == format!("@{}:{}", user.username, user.homeserver))
}

fn run(text: &str, look: &Look) -> TextRun {
    TextRun {
        len: text.len(),
        font: look.font.clone(),
        color: look.color,
        background_color: look.background,
        underline: look.underline.then(|| UnderlineStyle {
            thickness: px(1.0),
            color: Some(look.color),
            wavy: false,
        }),
        strikethrough: look.strike.then(|| StrikethroughStyle {
            thickness: px(1.0),
            color: Some(look.color),
        }),
    }
}

/// What a click on a span does: open its link or reveal its spoiler.
#[derive(Clone)]
enum Click {
    Link(String),
    Reveal(usize),
}

fn click_for(style: &SpanStyle, revealed: &HashSet<usize>) -> Option<Click> {
    match style.spoiler {
        Some(spoiler) if !revealed.contains(&spoiler) => Some(Click::Reveal(spoiler)),
        _ => style.link.clone().map(Click::Link),
    }
}

fn on_click(click: &Click, spoilers: &Entity<HashSet<usize>>, cx: &mut App) {
    match click {
        Click::Link(url) => desktop::open_url(url, cx),
        Click::Reveal(spoiler) => spoilers.update(cx, |revealed, cx| {
            revealed.insert(*spoiler);
            cx.notify();
        }),
    }
}

/// Draws `spans` as one paragraph. `id` keys its spoilers' revealed state.
pub fn rich_text(
    id: ElementId,
    spans: Vec<Span>,
    options: TextOptions,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let realtime = Realtime::global(cx);
    let wanted: Vec<String> = spans
        .iter()
        .filter_map(|span| span.style.emoji.clone())
        .filter(|unicode| !realtime.read(cx).emoji_urls.contains_key(unicode))
        .collect();
    if !wanted.is_empty() {
        realtime.update(cx, |realtime, cx| realtime.query_emojis(&wanted, cx));
    }
    let emoji_urls = &realtime.read(cx).emoji_urls;
    let images: Vec<Option<String>> = spans
        .iter()
        .map(|span| {
            span.style
                .emoji
                .as_ref()
                .and_then(|unicode| emoji_urls.get(unicode).cloned())
        })
        .collect();
    let spoilers = window.use_keyed_state(id.clone(), cx, |_, _| HashSet::<usize>::new());
    let revealed = spoilers.read(cx).clone();

    if images.iter().all(Option::is_none) {
        styled_paragraph(id, spans, options, &revealed, spoilers, cx)
    } else {
        flowing_paragraph(id, spans, images, options, &revealed, spoilers, cx)
    }
}

fn styled_paragraph(
    id: ElementId,
    spans: Vec<Span>,
    options: TextOptions,
    revealed: &HashSet<usize>,
    spoilers: Entity<HashSet<usize>>,
    cx: &mut App,
) -> AnyElement {
    let mut text = String::new();
    let mut runs = Vec::new();
    let mut clicks: Vec<(std::ops::Range<usize>, Click)> = Vec::new();
    let mut tooltips: Vec<(std::ops::Range<usize>, String)> = Vec::new();
    for span in &spans {
        if span.text.is_empty() {
            continue;
        }
        let look = look(&span.style, &options, revealed, &span.text, cx);
        let range = text.len()..text.len() + span.text.len();
        runs.push(run(&span.text, &look));
        if let Some(click) = click_for(&span.style, revealed) {
            clicks.push((range.clone(), click));
        }
        if let Some(tooltip) = &span.style.trailing {
            tooltips.push((range, tooltip.clone()));
        }
        text.push_str(&span.text);
    }
    let styled = StyledText::new(text).with_runs(runs);
    let ranges: Vec<_> = clicks.iter().map(|(range, _)| range.clone()).collect();
    let mut interactive = InteractiveText::new(id, styled).on_click(ranges, move |index, _, cx| {
        on_click(&clicks[index].1, &spoilers, cx);
    });
    if !tooltips.is_empty() {
        interactive = interactive.tooltip(move |index, window, cx| {
            tooltips
                .iter()
                .find(|(range, _)| range.contains(&index))
                .map(|(_, text)| Tooltip::new(text.clone()).build(window, cx))
        });
    }
    div()
        .text_size(options.size)
        .text_color(options.color)
        .when(options.truncate, |div| div.truncate())
        .child(interactive)
        .into_any_element()
}

/// Words and emoji images in a wrapping row, for paragraphs `StyledText` can't draw.
fn flowing_paragraph(
    id: ElementId,
    spans: Vec<Span>,
    images: Vec<Option<String>>,
    options: TextOptions,
    revealed: &HashSet<usize>,
    spoilers: Entity<HashSet<usize>>,
    cx: &mut App,
) -> AnyElement {
    let emoji_size = options.size * 1.35;
    let mut row = div()
        .flex()
        .flex_wrap()
        .items_center()
        .text_size(options.size)
        .text_color(options.color)
        .when(options.truncate, |row| row.flex_nowrap().overflow_hidden());
    let mut word = 0;
    for (span, image) in spans.into_iter().zip(images) {
        if let Some(url) = image {
            let image = crate::ui::image::remote_img(&url, cx);
            row = row.child(
                div()
                    .id(sub_id(&id, word))
                    .flex_shrink_0()
                    .size(emoji_size)
                    .children(image.map(|image| image.object_fit(ObjectFit::Contain)))
                    .tooltip({
                        let text = span.text.clone();
                        move |window, cx| Tooltip::new(text.clone()).build(window, cx)
                    }),
            );
            word += 1;
            continue;
        }
        let look = look(&span.style, &options, revealed, &span.text, cx);
        let click = click_for(&span.style, revealed);
        for (index, line) in span.text.split('\n').enumerate() {
            if index > 0 {
                row = row.child(div().w_full().h_0());
                if line.is_empty() {
                    row = row.child(div().w_full().h(options.size * 1.625));
                }
            }
            for piece in line.split_inclusive(' ') {
                let text = piece.to_string();
                let styled = StyledText::new(text.clone()).with_runs(vec![run(&text, &look)]);
                let token = div()
                    .id(sub_id(&id, word))
                    .flex_shrink_0()
                    .whitespace_nowrap()
                    .child(styled);
                word += 1;
                row = row.child(match click.clone() {
                    Some(click) => {
                        let spoilers = spoilers.clone();
                        token
                            .cursor_pointer()
                            .on_click(move |_, _, cx| on_click(&click, &spoilers, cx))
                            .into_any_element()
                    }
                    None => token.into_any_element(),
                });
            }
        }
    }
    row.into_any_element()
}

/// `id` with a child part, for the many ids a paragraph or a list row needs.
pub fn sub_id(id: &ElementId, part: impl std::fmt::Display) -> ElementId {
    (id.clone(), SharedString::from(part.to_string())).into()
}

/// `<EmojiText content links />` on its own (status lines, names in the panels ported elsewhere).
#[allow(dead_code)]
pub fn emoji_text(
    id: impl Into<ElementId>,
    content: &str,
    links: bool,
    options: TextOptions,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    rich_text(
        id.into(),
        spans_for(content, links, &SpanStyle::default()),
        options,
        window,
        cx,
    )
}

#[cfg(test)]
mod tests {
    use super::{Part, PartKind, handles, parts};

    fn kinds(content: &str, links: bool) -> Vec<(String, PartKind)> {
        parts(content, links)
            .into_iter()
            .map(|Part { text, kind }| (text, kind))
            .collect()
    }

    #[test]
    fn splits_urls_mentions_and_text() {
        assert_eq!(
            kinds("hi @ana:novarum.me see https://x.com/a", true),
            vec![
                ("hi ".into(), PartKind::Text),
                ("@ana:novarum.me".into(), PartKind::Mention),
                (" see ".into(), PartKind::Text),
                ("https://x.com/a".into(), PartKind::Url),
            ]
        );
        assert_eq!(
            kinds("https://x.com", false),
            vec![("https://x.com".into(), PartKind::Text)]
        );
        assert_eq!(
            kinds("me@ana:x.com", true),
            vec![("me@ana:x.com".into(), PartKind::Text)]
        );
        assert_eq!(
            kinds("@everyone!", true),
            vec![
                ("@everyone".into(), PartKind::Mention),
                ("!".into(), PartKind::Text)
            ]
        );
        assert_eq!(
            kinds("@everyone:x.com", true),
            vec![("@everyone:x.com".into(), PartKind::Mention)]
        );
    }

    #[test]
    fn finds_emoji_graphemes_and_their_keys() {
        let emoji = |content: &str| -> Vec<String> {
            parts(content, false)
                .into_iter()
                .filter_map(|part| match part.kind {
                    PartKind::Emoji(key) => Some(key),
                    _ => None,
                })
                .collect()
        };
        assert_eq!(emoji("hi 👋🏽!"), ["1F44B-1F3FD"]);
        assert_eq!(emoji("❤️"), ["2764-FE0F"]);
        assert_eq!(emoji("👨‍👩‍👧"), ["1F468-200D-1F469-200D-1F467"]);
        assert_eq!(emoji("🇪🇸🇫🇷"), ["1F1EA-1F1F8", "1F1EB-1F1F7"]);
        assert_eq!(emoji("1️⃣ and 1"), ["31-FE0F-20E3"]);
        assert!(emoji("plain text 123").is_empty());
    }

    #[test]
    fn lists_handles_but_not_everyone() {
        assert_eq!(
            handles("@a:x.com and @everyone and @b.c:y.org."),
            ["@a:x.com", "@b.c:y.org"]
        );
    }
}
