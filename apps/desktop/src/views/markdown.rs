// Port of apps/frontend/src/lib/components/markdown.svelte: draws the tree util::markdown parses.
// `inline` flattens everything to one line (reply previews); `compact` shrinks headings (profile
// cards); `trailing` goes at the end of the last paragraph ("(edited)").
use std::sync::LazyLock;

use gpui_kit::component::ActiveTheme;
use regex::Regex;

use crate::prelude::*;

use crate::{
    util::markdown::{Block, Inline, parse_inline, parse_markdown},
    views::emoji_text::{Span, SpanStyle, TextOptions, rich_text, spans_for, sub_id},
};

#[derive(Clone, Default)]
pub struct MarkdownOptions {
    pub links: bool,
    pub inline: bool,
    pub compact: bool,
    /// the "(edited)" text and its tooltip
    pub trailing: Option<(String, String)>,
}

/// The spans of an inline tree. Spoilers are numbered in order so each can be revealed alone.
pub fn inline_spans(nodes: &[Inline], links: bool) -> Vec<Span> {
    fn walk(nodes: &[Inline], links: bool, style: &SpanStyle, spoilers: &mut usize, out: &mut Vec<Span>) {
        for node in nodes {
            let mut next = style.clone();
            let children = match node {
                Inline::Text(text) => {
                    out.extend(spans_for(text, links, style));
                    continue;
                }
                Inline::Code(text) => {
                    next.code = true;
                    out.push(Span { text: text.clone(), style: next });
                    continue;
                }
                Inline::Bold(children) => {
                    next.bold = true;
                    children
                }
                Inline::Italic(children) => {
                    next.italic = true;
                    children
                }
                Inline::Underline(children) => {
                    next.underline = true;
                    children
                }
                Inline::Strike(children) => {
                    next.strike = true;
                    children
                }
                Inline::Spoiler(children) => {
                    next.spoiler = Some(*spoilers);
                    *spoilers += 1;
                    children
                }
                Inline::Link { url, children } => {
                    if links {
                        next.link = Some(url.clone());
                        next.underline = true;
                    }
                    children
                }
            };
            walk(children, links, &next, spoilers, out);
        }
    }
    let mut out = Vec::new();
    walk(nodes, links, &SpanStyle::default(), &mut 0, &mut out);
    out
}

/// `/\s+/g` → `' '`
pub fn collapse_whitespace(content: &str) -> String {
    static WHITESPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
    WHITESPACE.replace_all(content, " ").into_owned()
}

fn with_trailing(mut spans: Vec<Span>, trailing: &Option<(String, String)>) -> Vec<Span> {
    if let Some((text, tooltip)) = trailing {
        spans.push(Span { text: format!(" {text}"), style: SpanStyle { trailing: Some(tooltip.clone()), ..Default::default() } });
    }
    spans
}

/// `<Markdown content ... />`: text size and color come from `base`.
pub fn markdown(
    id: impl Into<ElementId>,
    content: &str,
    options: MarkdownOptions,
    base: TextOptions,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let id: ElementId = id.into();
    if options.inline {
        let spans = inline_spans(&parse_inline(&collapse_whitespace(content)), options.links);
        return rich_text(id, spans, TextOptions { truncate: true, ..base }, window, cx);
    }
    let blocks = parse_markdown(content);
    let mut root = div().flex().flex_col().min_w_0();
    let count = blocks.len();
    for (index, block) in blocks.iter().enumerate() {
        let trailing = if index + 1 == count { options.trailing.clone() } else { None };
        root = root.child(render_block(id.clone(), index, block, &options, trailing, base, window, cx));
    }
    if count == 0 && options.trailing.is_some() {
        root = root.child(rich_text((id, "trailing").into(), with_trailing(vec![], &options.trailing), base, window, cx));
    }
    root.into_any_element()
}

#[allow(clippy::too_many_arguments)]
fn render_block(
    id: ElementId,
    index: usize,
    block: &Block,
    options: &MarkdownOptions,
    trailing: Option<(String, String)>,
    base: TextOptions,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let t = theme::tokens(cx);
    let id = sub_id(&id, index);
    match block {
        Block::Paragraph(children) => {
            rich_text(id, with_trailing(inline_spans(children, options.links), &trailing), base, window, cx)
        }
        Block::Heading { level, children } => {
            let (size, weight) = match (options.compact, level) {
                (false, 1) => (px(20.0), FontWeight::BOLD),
                (false, 2) => (px(18.0), FontWeight::BOLD),
                (false, _) => (px(16.0), FontWeight::SEMIBOLD),
                (true, 1) => (px(14.0), FontWeight::BOLD),
                (true, 2) => (px(14.0), FontWeight::SEMIBOLD),
                (true, _) => (base.size, FontWeight::SEMIBOLD),
            };
            let heading = TextOptions { size, weight, color: t.foreground, truncate: options.compact };
            div()
                .mt_1()
                .line_height(relative(1.375))
                .child(rich_text(id, with_trailing(inline_spans(children, options.links), &trailing), heading, window, cx))
                .into_any_element()
        }
        Block::Code(code) => div()
            .flex()
            .flex_col()
            .child(
                div()
                    .id(id.clone())
                    .my_1()
                    .overflow_x_scroll()
                    .rounded(t.radius)
                    .border_1()
                    .border_color(t.border)
                    .bg(t.muted)
                    .px_3()
                    .py_2()
                    .font_family(cx.theme().mono_font_family.clone())
                    .text_size(base.size * 0.85)
                    .line_height(relative(1.5))
                    .whitespace_nowrap()
                    .child(code.clone()),
            )
            .when_some(trailing, |div, trailing| {
                div.child(rich_text((id, "trailing").into(), with_trailing(vec![], &Some(trailing)), base, window, cx))
            })
            .into_any_element(),
        Block::Quote(children) => {
            let mut quote = div().flex().flex_col().border_l(px(3.0)).border_color(t.muted_foreground.opacity(0.4)).pl_3();
            let count = children.len();
            for (child_index, child) in children.iter().enumerate() {
                let trailing = if child_index + 1 == count { trailing.clone() } else { None };
                quote = quote.child(render_block(id.clone(), child_index, child, options, trailing, base, window, cx));
            }
            quote.into_any_element()
        }
        Block::List { ordered, start, items } => {
            let mut list = div().flex().flex_col();
            for (item_index, item) in items.iter().enumerate() {
                let marker = if *ordered { format!("{}.", start + item_index as u64) } else { "•".into() };
                list = list.child(
                    div()
                        .flex()
                        .child(div().w_6().flex_shrink_0().flex().justify_end().pr_1p5().text_color(t.muted_foreground).child(marker))
                        .child(div().flex_1().min_w_0().child(rich_text(
                            sub_id(&id, item_index),
                            inline_spans(item, options.links),
                            base,
                            window,
                            cx,
                        ))),
                );
            }
            list.when_some(trailing, |div, trailing| {
                div.child(rich_text((id, "trailing").into(), with_trailing(vec![], &Some(trailing)), base, window, cx))
            })
            .into_any_element()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{collapse_whitespace, inline_spans};
    use crate::util::markdown::parse_inline;

    #[test]
    fn flattens_styles_into_spans() {
        let spans = inline_spans(&parse_inline("a **b _c_** ||s|| ||t|| [l](https://x.com)"), true);
        let texts: Vec<&str> = spans.iter().map(|span| span.text.as_str()).collect();
        assert_eq!(texts, ["a ", "b ", "c", " ", "s", " ", "t", " ", "l"]);
        assert!(spans[2].style.bold && spans[2].style.italic);
        assert_eq!((spans[4].style.spoiler, spans[6].style.spoiler), (Some(0), Some(1)));
        assert_eq!(spans[8].style.link.as_deref(), Some("https://x.com"));
        let unlinked = inline_spans(&parse_inline("[l](https://x.com)"), false);
        assert_eq!(unlinked[0].style.link, None);
    }

    #[test]
    fn collapses_whitespace_like_the_web() {
        assert_eq!(collapse_whitespace("a\n\n  b"), "a b");
        assert_eq!(collapse_whitespace(" a b\t"), " a b ");
    }
}
