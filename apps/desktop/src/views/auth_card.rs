// The pieces of `auth_backdrop` for the pages whose cards don't fit its fixed centered header and
// footer (reset-password's later steps, invite and authorize): the dark page, the card shell,
// a header and a footer link.
use crate::prelude::*;

use crate::{
    state::router,
    theme::{self, Tokens},
    views::constellation::ConstellationBackground,
};

/// `<div class="dark ...">` with the starfield, the logo in the corner and `card` centered.
/// `glow` adds the two radial gradients; `logo_href` makes the logo a link.
pub fn auth_page(card: Div, glow: bool, logo_href: Option<&'static str>, cx: &mut App) -> AnyElement {
    let t = Tokens::dark();
    let background = ConstellationBackground::global(cx);
    let radius = theme::tokens(cx).radius;
    div()
        .relative()
        .size_full()
        .overflow_hidden()
        .bg(t.background)
        .text_color(t.foreground)
        .child(div().absolute().inset_0().child(background))
        .when(glow, |page| {
            page.child(
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(div().size(px(240.0)).rounded_full().bg(rgba(0x82afeb10)).shadow(vec![BoxShadow {
                        color: rgba(0x82afeb10).into(),
                        offset: point(px(0.0), px(0.0)),
                        blur_radius: px(320.0),
                        spread_radius: px(160.0),
                        inset: false,
                    }])),
            )
        })
        .child(
            div()
                .id("auth-logo")
                .absolute()
                .top_6()
                .left_6()
                .flex()
                .items_center()
                .gap(px(10.0))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_center()
                        .size_9()
                        .bg(t.primary)
                        .rounded(radius)
                        .child(svg().path("logo.svg").size_5().text_color(white())),
                )
                .child(div().text_lg().font_weight(FontWeight::SEMIBOLD).child("novarum"))
                .when_some(logo_href, |logo, href| {
                    logo.cursor_pointer().on_click(move |_, _, cx| router::goto(href, cx))
                }),
        )
        .child(
            div()
                .id("auth-scroll")
                .relative()
                .size_full()
                .overflow_y_scroll()
                .flex()
                .items_center()
                .justify_center()
                .p_4()
                .child(card),
        )
        .into_any_element()
}

/// `Card.Root` with `border-white/10 bg-card/70 shadow-2xl shadow-black/50`; `opacity` is the card
/// fill (the backdrop blur is missing, so it runs a bit more opaque than the web's).
pub fn auth_card(opacity: f32, cx: &App) -> Div {
    let t = Tokens::dark();
    crate::ui::card(cx)
        .w_full()
        .max_w(px(448.0))
        .py_6()
        .gap_6()
        .border_color(white().opacity(0.1))
        .bg(t.card.opacity(opacity))
        .shadow(vec![BoxShadow {
            color: black().opacity(0.5),
            offset: point(px(0.0), px(25.0)),
            blur_radius: px(50.0),
            spread_radius: px(-12.0),
            inset: false,
        }])
}

/// `Card.Header`: a `text-xl` title over a muted description, left-aligned like shadcn's.
pub fn card_header(title: impl Into<SharedString>, description: Option<AnyElement>) -> Div {
    let t = Tokens::dark();
    div()
        .px_6()
        .flex()
        .flex_col()
        .gap_1()
        .child(div().text_xl().font_weight(FontWeight::SEMIBOLD).child(title.into()))
        .when_some(description, |header, description| {
            header.child(div().text_sm().text_color(t.muted_foreground).child(description))
        })
}

/// `Card.Footer class="justify-center text-xs text-muted-foreground"` with a trailing link.
pub fn footer_link(
    prompt: impl Into<SharedString>,
    id: &'static str,
    link: impl Into<SharedString>,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Div {
    let t = Tokens::dark();
    div()
        .px_6()
        .flex()
        .justify_center()
        .items_center()
        .text_xs()
        .text_color(t.muted_foreground)
        .child(prompt.into())
        .child(
            div()
                .id(id)
                .ml_1()
                .font_weight(FontWeight::MEDIUM)
                .text_color(t.foreground)
                .cursor_pointer()
                .hover(|s| s.underline())
                .child(link.into())
                .on_click(on_click),
        )
}

/// `<LoaderCircle class="size-8 animate-spin" />`
pub fn big_spinner(id: &'static str) -> impl IntoElement {
    crate::ui::icon("loader-circle").size_8().with_animation(
        id,
        Animation::new(std::time::Duration::from_secs(1)).repeat(),
        |icon, delta| icon.transform(Transformation::rotate(percentage(delta))),
    )
}

/// Tailwind's emerald and amber, for the success and warning bits of these pages.
pub fn emerald(shade: u16) -> Hsla {
    match shade {
        300 => theme::oklch(0.845, 0.143, 164.978, 1.0),
        400 => theme::oklch(0.765, 0.177, 163.223, 1.0),
        _ => theme::oklch(0.696, 0.17, 162.48, 1.0),
    }
}

pub fn amber_500() -> Hsla {
    theme::oklch(0.769, 0.188, 70.08, 1.0)
}

/// The `<CircleCheck class="size-3" />Looks good` hint under a password field.
pub fn check_hint(text: &'static str) -> Div {
    div()
        .flex()
        .items_center()
        .gap_1()
        .text_xs()
        .text_color(emerald(400))
        .child(crate::ui::icon("circle-check").size_3())
        .child(text)
}

/// zod's `z.email()` pattern, without the regex.
pub fn validate_email(value: &str) -> Option<&'static str> {
    let valid = value.split_once('@').is_some_and(|(local, domain)| {
        let local_ok = !local.is_empty()
            && !local.starts_with('.')
            && !local.ends_with('.')
            && !local.contains("..")
            && local.chars().all(|c| c.is_ascii_alphanumeric() || "_'+-.".contains(c));
        let labels: Vec<&str> = domain.split('.').collect();
        let domain_ok = labels.len() >= 2
            && labels[..labels.len() - 1].iter().all(|label| {
                label.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
                    && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            })
            && labels.last().is_some_and(|tld| tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic()));
        local_ok && domain_ok
    });
    (!valid).then_some("Enter a valid email.")
}

/// The `password` / `confirmPassword` checks of the register and reset schemas.
pub fn validate_passwords(password: &str, confirm: &str) -> [Option<&'static str>; 2] {
    [
        (password.chars().count() < 8).then_some("At least 8 characters."),
        if confirm.is_empty() {
            Some("Confirm your password.")
        } else {
            (password != confirm).then_some("Passwords don't match.")
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::{validate_email, validate_passwords};

    #[test]
    fn validates_emails() {
        assert_eq!(validate_email("ana@novarum.me"), None);
        assert_eq!(validate_email("a.b+c@mail.example.org"), None);
        assert!(validate_email("ana").is_some());
        assert!(validate_email("ana@localhost").is_some());
        assert!(validate_email(".ana@x.io").is_some());
        assert!(validate_email("ana@-x.io").is_some());
    }

    #[test]
    fn validates_passwords() {
        assert_eq!(validate_passwords("hunter22", "hunter22"), [None, None]);
        assert_eq!(validate_passwords("short", ""), [Some("At least 8 characters."), Some("Confirm your password.")]);
        assert_eq!(validate_passwords("hunter22", "hunter23")[1], Some("Passwords don't match."));
    }
}
