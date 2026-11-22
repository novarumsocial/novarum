// Port of apps/frontend/src/lib/markdown.ts: chat markdown parsed to a small tree, never to markup.
// Links are limited to http(s). Indices are chars where the web uses UTF-16 units.
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, LazyLock, Mutex},
};

#[derive(Debug, Clone, PartialEq)]
pub enum Inline {
    Text(String),
    Code(String),
    Bold(Vec<Inline>),
    Italic(Vec<Inline>),
    Underline(Vec<Inline>),
    Strike(Vec<Inline>),
    Spoiler(Vec<Inline>),
    Link { url: String, children: Vec<Inline> },
}

#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    Paragraph(Vec<Inline>),
    Heading { level: usize, children: Vec<Inline> },
    Code(String),
    Quote(Vec<Block>),
    List { ordered: bool, start: u64, items: Vec<Vec<Inline>> },
}

type Span = (&'static str, fn(Vec<Inline>) -> Inline);

const SPANS: [Span; 6] = [
    ("**", Inline::Bold),
    ("__", Inline::Underline),
    ("~~", Inline::Strike),
    ("||", Inline::Spoiler),
    ("*", Inline::Italic),
    ("_", Inline::Italic),
];

fn word(c: Option<&char>) -> bool {
    c.is_some_and(|c| c.is_alphanumeric())
}

fn space(c: Option<&char>) -> bool {
    c.is_some_and(|c| c.is_whitespace())
}

fn starts_with(src: &[char], at: usize, pattern: &str) -> bool {
    pattern.chars().enumerate().all(|(offset, c)| src.get(at + offset) == Some(&c))
}

fn index_of(src: &[char], pattern: &str, from: usize) -> Option<usize> {
    (from..src.len()).find(|&index| starts_with(src, index, pattern))
}

fn text(src: &[char]) -> String {
    src.iter().collect()
}

/// `https?://` followed by a run of chars that aren't whitespace or `stop`: where the run ends.
fn url_at(src: &[char], at: usize, stop: Option<char>) -> Option<usize> {
    let scheme = if starts_with(src, at, "https://") {
        8
    } else if starts_with(src, at, "http://") {
        7
    } else {
        return None;
    };
    let start = at + scheme;
    let end =
        (start..src.len()).find(|&index| src[index].is_whitespace() || Some(src[index]) == stop).unwrap_or(src.len());
    (end > start).then_some(end)
}

/// `[label](https://...)` at `at`: the label, the url and where it ends.
fn link_at(src: &[char], at: usize) -> Option<(String, String, usize)> {
    let close = (at + 1..src.len()).find(|&index| src[index] == ']' || src[index] == '\n')?;
    if src[close] != ']' || close == at + 1 || src.get(close + 1) != Some(&'(') {
        return None;
    }
    let url_start = close + 2;
    let end = url_at(src, url_start, Some(')'))?;
    (src.get(end) == Some(&')')).then(|| (text(&src[at + 1..close]), text(&src[url_start..end]), end + 1))
}

/// `` (`{1,3})(content)\1(?!`) `` at `at`: the code and where it ends.
fn code_at(src: &[char], at: usize) -> Option<(String, usize)> {
    let run = src[at..].iter().take(4).take_while(|&&c| c == '`').count();
    if run > 3 || src.get(at + run).is_none_or(|&c| c == '`') {
        return None;
    }
    let start = at + run;
    (start + 1..=src.len()).find_map(|end| {
        let closes = src[end - 1] != '`'
            && (0..run).all(|offset| src.get(end + offset) == Some(&'`'))
            && src.get(end + run) != Some(&'`');
        closes.then(|| (text(&src[start..end]), end + run))
    })
}

/// where a span whose content starts at `from` closes. Single `*`/`_` skip doubled runs, and `_`
/// needs word edges (snake_case)
fn closing(src: &[char], delimiter: &str, from: usize) -> Option<usize> {
    let first = delimiter.chars().next()?;
    let length = delimiter.chars().count();
    let mut end = index_of(src, delimiter, from + 1);
    while let Some(index) = end {
        let skip = space(src.get(index - 1))
            || src.get(index + length) == Some(&first)
            || (length == 1 && src.get(index - 1) == Some(&first))
            || (delimiter == "_" && word(src.get(index + 1)));
        if !skip {
            return Some(index);
        }
        end = index_of(src, delimiter, index + 1);
    }
    None
}

fn escapable(c: Option<&char>) -> bool {
    c.is_some_and(|c| "\\`*_~|[]()#>.+-".contains(*c))
}

fn plain(c: char) -> bool {
    !"\\`*_~|[h".contains(c)
}

pub fn parse_inline(src: &str) -> Vec<Inline> {
    inline(&src.chars().collect::<Vec<_>>(), 0)
}

// nesting is capped so a wall of `*` can't recurse thousands deep
fn inline(src: &[char], depth: usize) -> Vec<Inline> {
    let mut out = Vec::new();
    // a delimiter with no valid closer won't find one further on either, so it's never searched
    // again (linear time)
    let mut unclosed: HashSet<&str> = HashSet::new();
    let mut text_run = String::new();
    let push = |out: &mut Vec<Inline>, text_run: &mut String, node: Inline| {
        if !text_run.is_empty() {
            out.push(Inline::Text(std::mem::take(text_run)));
        }
        out.push(node);
    };

    let mut i = 0;
    while i < src.len() {
        let c = src[i];
        if c == '\\' && escapable(src.get(i + 1)) {
            text_run.push(src[i + 1]);
            i += 2;
            continue;
        }
        if plain(c) {
            let end = (i..src.len()).find(|&index| !plain(src[index])).unwrap_or(src.len());
            text_run.extend(&src[i..end]);
            i = end;
            continue;
        }

        // bare urls stay text (the text renderer links them) so `_` or `*` inside aren't formatting
        if c == 'h'
            && let Some(end) = url_at(src, i, None)
        {
            text_run.extend(&src[i..end]);
            i = end;
            continue;
        }
        if c == '['
            && let Some((label, url, end)) = link_at(src, i)
        {
            let children = inline(&label.chars().collect::<Vec<_>>(), depth + 1);
            push(&mut out, &mut text_run, Inline::Link { url, children });
            i = end;
            continue;
        }
        if c == '`' && !unclosed.contains("`") {
            match code_at(src, i) {
                Some((code, end)) => {
                    push(&mut out, &mut text_run, Inline::Code(code));
                    i = end;
                    continue;
                }
                None => {
                    unclosed.insert("`");
                }
            }
        }

        if let Some(&(delimiter, make)) = SPANS.iter().find(|(delimiter, _)| starts_with(src, i, delimiter)) {
            let length = delimiter.len();
            let after = src.get(i + length);
            let opens =
                depth < 6 && after.is_some() && !space(after) && !(delimiter == "_" && i > 0 && word(src.get(i - 1)));
            let end = if opens && !unclosed.contains(delimiter) { closing(src, delimiter, i + length) } else { None };
            if opens && end.is_none() {
                unclosed.insert(delimiter);
            }
            if let Some(end) = end {
                push(&mut out, &mut text_run, make(inline(&src[i + length..end], depth + 1)));
                i = end + length;
                continue;
            }
        }

        text_run.push(c);
        i += 1;
    }

    if !text_run.is_empty() {
        out.push(Inline::Text(text_run));
    }
    out
}

fn is_fence(line: &str) -> bool {
    let rest = line.trim_start().strip_prefix("```");
    rest.is_some_and(|rest| {
        let info = rest.trim_end();
        info.chars().all(|c| c.is_ascii_alphanumeric() || "_+#.-".contains(c))
    })
}

/// `^(#{1,3}) +(.+)$`
fn heading(line: &str) -> Option<(usize, &str)> {
    let level = line.chars().take_while(|&c| c == '#').count();
    if !(1..=3).contains(&level) {
        return None;
    }
    let after = &line[level..];
    let rest = after.trim_start_matches(' ');
    let spaces = after.len() - rest.len();
    match (spaces, rest.is_empty()) {
        (0, _) => None,
        (_, false) => Some((level, rest)),
        // the spaces backtrack so `.+` still gets one
        (2.., true) => Some((level, " ")),
        _ => None,
    }
}

fn is_quote(line: &str) -> bool {
    line == ">" || line.starts_with("> ")
}

/// `^\s*([-*+]|\d{1,9}[.)]) +(.*)$`: the marker and the item's text.
fn list_item(line: &str) -> Option<(&str, &str)> {
    let trimmed = line.trim_start();
    let digits = trimmed.chars().take_while(|c| c.is_ascii_digit()).count();
    let marker_length = match trimmed.chars().next()? {
        '-' | '*' | '+' => 1,
        _ if (1..=9).contains(&digits) && matches!(trimmed[digits..].chars().next(), Some('.' | ')')) => digits + 1,
        _ => return None,
    };
    let marker = &trimmed[..marker_length];
    let rest = &trimmed[marker_length..];
    let text = rest.trim_start_matches(' ');
    (text.len() < rest.len()).then_some((marker, text))
}

fn parse_blocks(lines: &[&str]) -> Vec<Block> {
    let mut blocks = Vec::new();
    let mut paragraph: Vec<&str> = Vec::new();
    let flush = |blocks: &mut Vec<Block>, paragraph: &mut Vec<&str>| {
        let joined = paragraph.join("\n");
        let text = joined.trim_matches('\n');
        if !text.is_empty() {
            blocks.push(Block::Paragraph(parse_inline(text)));
        }
        paragraph.clear();
    };

    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let fence =
            if is_fence(line) { (i + 1..lines.len()).find(|&index| lines[index].trim() == "```") } else { None };

        if let Some(fence) = fence {
            flush(&mut blocks, &mut paragraph);
            blocks.push(Block::Code(lines[i + 1..fence].join("\n")));
            i = fence;
        } else if let Some((level, text)) = heading(line) {
            flush(&mut blocks, &mut paragraph);
            blocks.push(Block::Heading { level, children: parse_inline(text) });
        } else if is_quote(line) {
            flush(&mut blocks, &mut paragraph);
            let mut quoted = Vec::new();
            while i < lines.len() && is_quote(lines[i]) {
                let line = &lines[i][1..];
                quoted.push(line.strip_prefix(' ').unwrap_or(line));
                i += 1;
            }
            blocks.push(Block::Quote(parse_blocks(&quoted)));
            continue;
        } else if let Some((first, _)) = list_item(line) {
            flush(&mut blocks, &mut paragraph);
            let ordered = first.starts_with(|c: char| c.is_ascii_digit());
            let mut items = Vec::new();
            while let Some((marker, text)) = lines.get(i).and_then(|line| list_item(line)) {
                if marker.starts_with(|c: char| c.is_ascii_digit()) != ordered {
                    break;
                }
                items.push(parse_inline(text));
                i += 1;
            }
            let start = if ordered { first[..first.len() - 1].parse().unwrap_or(1) } else { 1 };
            blocks.push(Block::List { ordered, start, items });
            continue;
        } else {
            paragraph.push(line);
        }
        i += 1;
    }

    flush(&mut blocks, &mut paragraph);
    blocks
}

type Cache = (HashMap<String, Arc<Vec<Block>>>, VecDeque<String>);

// messages re-render often (typing, scrolling), so parsed trees are cached by content
static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(Mutex::default);

pub fn parse_markdown(src: &str) -> Arc<Vec<Block>> {
    if let Some(blocks) = CACHE.lock().unwrap().0.get(src) {
        return blocks.clone();
    }
    let blocks = Arc::new(parse_blocks(&src.split('\n').collect::<Vec<_>>()));
    let mut cache = CACHE.lock().unwrap();
    if cache.1.len() >= 1000
        && let Some(oldest) = cache.1.pop_front()
    {
        cache.0.remove(&oldest);
    }
    cache.0.insert(src.into(), blocks.clone());
    cache.1.push_back(src.into());
    blocks
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::{Block, Inline, parse_inline, parse_markdown};

    fn text(value: &str) -> Inline {
        Inline::Text(value.into())
    }

    #[test]
    fn inline_styles_including_nesting() {
        assert_eq!(
            parse_inline("**b** *i* _i_ __u__ ~~s~~ ||spoiler||"),
            vec![
                Inline::Bold(vec![text("b")]),
                text(" "),
                Inline::Italic(vec![text("i")]),
                text(" "),
                Inline::Italic(vec![text("i")]),
                text(" "),
                Inline::Underline(vec![text("u")]),
                text(" "),
                Inline::Strike(vec![text("s")]),
                text(" "),
                Inline::Spoiler(vec![text("spoiler")]),
            ]
        );
        assert_eq!(parse_inline("***x***"), vec![Inline::Bold(vec![Inline::Italic(vec![text("x")])])]);
        assert_eq!(
            parse_inline("*a **b** c*"),
            vec![Inline::Italic(vec![text("a "), Inline::Bold(vec![text("b")]), text(" c")])]
        );
    }

    #[test]
    fn leaves_ordinary_punctuation_identifiers_urls_and_handles_alone() {
        for value in
            ["2 * 3 * 4", "a ** b", "**unclosed", "snake_case_name", "see https://x.com/*a*_b_ now", "@foo_bar:srv.com"]
        {
            assert_eq!(parse_inline(value), vec![text(value)], "{value}");
        }
    }

    #[test]
    fn backslash_escapes_and_code_spans_are_literal() {
        assert_eq!(parse_inline("\\*no\\*"), vec![text("*no*")]);
        assert_eq!(parse_inline("`a *b* <i>`"), vec![Inline::Code("a *b* <i>".into())]);
        assert_eq!(parse_inline("``a`b``"), vec![Inline::Code("a`b".into())]);
    }

    #[test]
    fn links_only_allow_http_and_html_stays_text() {
        assert_eq!(
            parse_inline("[hi **there**](https://e.com)"),
            vec![Inline::Link {
                url: "https://e.com".into(),
                children: vec![text("hi "), Inline::Bold(vec![text("there")])],
            }]
        );
        for value in [
            "[x](javascript:alert(1))",
            "[x](data:text/html,<script>alert(1)</script>)",
            "<img src=x onerror=alert(1)>",
        ] {
            assert_eq!(parse_inline(value), vec![text(value)], "{value}");
        }
    }

    #[test]
    fn blocks_code_fences_headings_quotes_and_lists() {
        assert_eq!(
            *parse_markdown(
                "hi\n```js\nconst a = **1**;\n```\n# Head\n> quote **b**\n> more\n- one\n* two\n3. a\n4. b\n\nend"
            ),
            vec![
                Block::Paragraph(vec![text("hi")]),
                Block::Code("const a = **1**;".into()),
                Block::Heading { level: 1, children: vec![text("Head")] },
                Block::Quote(vec![Block::Paragraph(vec![
                    text("quote "),
                    Inline::Bold(vec![text("b")]),
                    text("\nmore"),
                ])]),
                Block::List { ordered: false, start: 1, items: vec![vec![text("one")], vec![text("two")]] },
                Block::List { ordered: true, start: 3, items: vec![vec![text("a")], vec![text("b")]] },
                Block::Paragraph(vec![text("end")]),
            ]
        );
    }

    #[test]
    fn unclosed_fences_tags_and_deep_headings_stay_paragraphs() {
        assert_eq!(
            *parse_markdown("```\nnot closed\n#tag\n#### four"),
            vec![Block::Paragraph(vec![text("```\nnot closed\n#tag\n#### four")])]
        );
    }

    #[test]
    fn parses_adversarial_input_in_linear_time() {
        let start = Instant::now();
        for value in ["*", "a_", "**x ", "`", "[a](", "_a ", "||"] {
            parse_markdown(&value.repeat(20000));
        }
        assert!(start.elapsed().as_millis() < 1000, "{:?}", start.elapsed());
    }
}
