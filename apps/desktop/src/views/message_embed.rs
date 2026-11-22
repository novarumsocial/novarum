// Port of apps/frontend/src/lib/components/message-embed.svelte: a bot's rich card.
use chrono::{DateTime, Local};

use crate::prelude::*;

use crate::{
    desktop,
    models::Embed,
    state::settings::SettingsStore,
    util::format_date::{format_date, format_time},
    views::{
        emoji_text::{TextOptions, sub_id},
        markdown::{MarkdownOptions, markdown},
    },
};

/// The bar's color: the bot picks it; without one it is the quiet border color.
pub fn accent(color: Option<u32>) -> Option<Hsla> {
    color.map(|color| rgb(color & 0xFF_FFFF).into())
}

fn remote(url: &str, cx: &mut App) -> Option<Img> {
    crate::ui::image::remote(url, cx).ok().flatten().map(img)
}

fn link(id: impl Into<ElementId>, label: String, url: Option<String>) -> Stateful<Div> {
    let div = div().id(id).truncate().child(label);
    match url {
        Some(url) => div
            .cursor_pointer()
            .hover(|s| s.underline())
            .on_click(move |_, _, cx| desktop::open_url(&url, cx)),
        None => div,
    }
}

pub fn message_embed(
    id: impl Into<ElementId>,
    embed: &Embed,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let id: ElementId = id.into();
    let t = theme::tokens(cx);
    let body = TextOptions::new(px(14.0), t.foreground.opacity(0.85));
    let links = MarkdownOptions {
        links: true,
        ..Default::default()
    };

    let mut main = div().flex().flex_col().flex_1().min_w_0();
    if let Some(author) = &embed.author {
        main = main.child(
            div()
                .mb_1p5()
                .flex()
                .items_center()
                .gap_1p5()
                .text_xs()
                .font_weight(FontWeight::MEDIUM)
                .when_some(
                    author.icon_url.as_deref().and_then(|url| remote(url, cx)),
                    |row, image| row.child(image.size_5().object_fit(ObjectFit::Cover)),
                )
                .child(link(
                    (id.clone(), "author"),
                    author.name.clone(),
                    author.url.clone(),
                )),
        );
    }
    if let Some(title) = &embed.title {
        let title = div()
            .id((id.clone(), "title"))
            .text_sm()
            .font_weight(FontWeight::SEMIBOLD)
            .child(title.clone());
        main = main.child(match embed.url.clone() {
            Some(url) => title
                .text_color(t.link)
                .cursor_pointer()
                .hover(|s| s.underline())
                .on_click(move |_, _, cx| desktop::open_url(&url, cx)),
            None => title,
        });
    }
    if let Some(description) = &embed.description {
        main = main.child(div().mt_1().line_height(relative(1.625)).child(markdown(
            (id.clone(), "description"),
            description,
            links.clone(),
            body,
            window,
            cx,
        )));
    }
    if !embed.fields.is_empty() {
        let mut fields = div().mt_2().flex().flex_wrap().gap_x_4().gap_y_2();
        for (index, field) in embed.fields.iter().enumerate() {
            fields = fields.child(
                div()
                    .min_w_0()
                    .when(field.inline, |field| field.flex_1().min_w(px(96.0)))
                    .when(!field.inline, |field| field.w_full())
                    .child(
                        div()
                            .text_xs()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(field.name.clone()),
                    )
                    .child(markdown(
                        sub_id(&id, format!("field-{index}")),
                        &field.value,
                        links.clone(),
                        body,
                        window,
                        cx,
                    )),
            );
        }
        main = main.child(fields);
    }

    let thumbnail = embed
        .thumbnail
        .as_ref()
        .and_then(|thumbnail| remote(&thumbnail.url, cx));
    let image = embed
        .image
        .as_ref()
        .and_then(|image| remote(&image.url, cx));
    let timestamp = embed
        .timestamp
        .as_deref()
        .and_then(|timestamp| DateTime::parse_from_rfc3339(timestamp).ok())
        .map(|date| date.with_timezone(&Local));
    let footer = (embed.footer.is_some() || timestamp.is_some()).then(|| {
        let time_format = SettingsStore::get(cx).time_format;
        div()
            .mt_2()
            .flex()
            .items_center()
            .gap_1p5()
            .text_size(px(11.0))
            .text_color(t.muted_foreground)
            .when_some(
                embed
                    .footer
                    .as_ref()
                    .and_then(|footer| footer.icon_url.as_deref())
                    .and_then(|url| remote(url, cx)),
                |row, image| row.child(image.size_4().object_fit(ObjectFit::Cover)),
            )
            .when_some(embed.footer.as_ref(), |row, footer| {
                row.child(div().truncate().child(footer.text.clone()))
            })
            .when(embed.footer.is_some() && timestamp.is_some(), |row| {
                row.child("•")
            })
            .when_some(timestamp, |row, date| {
                row.child(format!(
                    "{} at {}",
                    format_date(&date, &Local::now()),
                    format_time(&date, time_format)
                ))
            })
    });

    let card = div()
        .flex()
        .flex_col()
        .flex_1()
        .min_w_0()
        .border_1()
        .border_l_0()
        .border_color(t.border)
        .py_2p5()
        .px_3()
        .child(
            div()
                .flex()
                .gap_x_4()
                .child(main)
                .when_some(thumbnail, |row, thumbnail| {
                    row.child(
                        thumbnail
                            .size_20()
                            .flex_shrink_0()
                            .object_fit(ObjectFit::Cover),
                    )
                }),
        )
        .when_some(image, |card, image| {
            card.child(
                div().mt_2p5().child(
                    image
                        .max_h(px(320.0))
                        .max_w_full()
                        .object_fit(ObjectFit::Contain),
                ),
            )
        })
        .children(footer);
    // `border-l-4` in the accent color
    div()
        .mt_1p5()
        .max_w(px(512.0))
        .flex()
        .bg(t.card.opacity(0.6))
        .child(
            div()
                .w_1()
                .flex_shrink_0()
                .bg(accent(embed.color).unwrap_or(t.border)),
        )
        .child(card)
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::accent;

    #[test]
    fn embed_colors_are_rgb() {
        assert!(accent(None).is_none());
        let red = accent(Some(0xFF0000)).unwrap().to_rgb();
        assert_eq!((red.r, red.g, red.b), (1.0, 0.0, 0.0));
    }
}
