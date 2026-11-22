// Port of apps/frontend/src/routes/reset-password/+page.svelte.
use crate::prelude::*;
use gpui_kit::component::{
    ActiveTheme,
    input::{Input, InputEvent, InputState},
};

use crate::{
    api,
    state::{
        router::{self, Router},
        session::Session,
    },
    theme,
    ui::{self, icon},
    views::{
        auth::field,
        auth_card::{
            auth_card, auth_page, card_header, emerald, footer_link, validate_email,
            validate_passwords,
        },
        login::validate_home_server,
    },
};

#[derive(Clone, Copy, PartialEq)]
enum Step {
    Request,
    Reset,
    Complete,
}

pub struct ResetPasswordPage {
    step: Step,
    email: String,
    home_server: Entity<InputState>,
    email_input: Entity<InputState>,
    code: Entity<InputState>,
    password: Entity<InputState>,
    confirm: Entity<InputState>,
    request_errors: [Option<String>; 2],
    reset_errors: [Option<String>; 3],
    request_loading: bool,
    reset_loading: bool,
    request_error: String,
    reset_error: String,
    show_password: bool,
    login_href: String,
    _subscriptions: Vec<Subscription>,
}

fn validate_code(code: &str) -> Option<&'static str> {
    (code.len() != 6 || !code.chars().all(|c| c.is_ascii_digit()))
        .then_some("Enter the 6-digit code.")
}

impl ResetPasswordPage {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let home_server = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("novarum.me")
                .default_value(api::anchor().home_server)
        });
        let email_input = cx.new(|cx| InputState::new(window, cx).placeholder("you@example.com"));
        let code = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("000000")
                .validate(|value, _| value.chars().count() <= 6)
        });
        let password = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("At least 8 characters")
                .masked(true)
        });
        let confirm = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Re-enter your password")
                .masked(true)
        });

        let mut subscriptions = Vec::new();
        // the request form validates on submit
        for input in [&home_server, &email_input] {
            subscriptions.push(cx.subscribe_in(
                input,
                window,
                |this, _, event: &InputEvent, window, cx| {
                    if let InputEvent::PressEnter { .. } = event {
                        this.request(window, cx);
                    }
                },
            ));
        }
        // the reset form validates as you type
        for (index, input) in [&code, &password, &confirm].into_iter().enumerate() {
            subscriptions.push(cx.subscribe_in(
                input,
                window,
                move |this, _, event: &InputEvent, window, cx| match event {
                    InputEvent::Change => {
                        this.reset_errors[index] = this.validate_reset(cx)[index].map(Into::into);
                        cx.notify();
                    }
                    InputEvent::PressEnter { .. } => this.reset(window, cx),
                    _ => {}
                },
            ));
        }

        let redirect = Router::global(cx).read(cx).param("redirect");
        let login_href = match redirect {
            Some(redirect) => format!(
                "/login?redirect={}",
                router::encode(&router::safe_redirect(Some(&redirect)))
            ),
            None => "/login".into(),
        };

        Self {
            step: Step::Request,
            email: String::new(),
            home_server,
            email_input,
            code,
            password,
            confirm,
            request_errors: Default::default(),
            reset_errors: Default::default(),
            request_loading: false,
            reset_loading: false,
            request_error: String::new(),
            reset_error: String::new(),
            show_password: false,
            login_href,
            _subscriptions: subscriptions,
        }
    }

    fn validate_reset(&self, cx: &App) -> [Option<&'static str>; 3] {
        let password = self.password.read(cx).value();
        let [password_error, confirm_error] =
            validate_passwords(&password, &self.confirm.read(cx).value());
        [
            validate_code(&self.code.read(cx).value()),
            password_error,
            confirm_error,
        ]
    }

    fn request(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.request_loading {
            return;
        }
        let home_server = self.home_server.read(cx).value().trim().to_string();
        let email = self.email_input.read(cx).value().to_string();
        self.request_errors = [
            validate_home_server(&home_server).map(Into::into),
            validate_email(&email).map(Into::into),
        ];
        self.request_error.clear();
        if self.request_errors.iter().any(Option::is_some) {
            cx.notify();
            return;
        }
        self.request_loading = true;
        self.email = email.trim().to_lowercase();
        cx.notify();

        let email = self.email.clone();
        cx.spawn_in(window, async move |this, cx| {
            let result = Session::request_password_reset(home_server, email).await;
            let _ = this.update_in(cx, |this, window, cx| {
                match result {
                    Ok(()) => {
                        this.step = Step::Reset;
                        this.code.update(cx, |code, cx| code.focus(window, cx));
                    }
                    Err(error) => this.request_error = error,
                }
                this.request_loading = false;
                cx.notify();
            });
        })
        .detach();
    }

    fn reset(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        if self.reset_loading {
            return;
        }
        self.reset_errors = self.validate_reset(cx).map(|error| error.map(Into::into));
        self.reset_error.clear();
        if self.reset_errors.iter().any(Option::is_some) {
            cx.notify();
            return;
        }
        self.reset_loading = true;
        cx.notify();

        let code = self.code.read(cx).value().parse().unwrap_or_default();
        let reset = Session::reset_password(
            self.email.clone(),
            self.password.read(cx).value().to_string(),
            code,
        );
        cx.spawn(async move |this, cx| {
            let result = reset.await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(()) => this.step = Step::Complete,
                    Err(error) => this.reset_error = error,
                }
                this.reset_loading = false;
                cx.notify();
            });
        })
        .detach();
    }

    fn toggle_password(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.show_password = !self.show_password;
        for input in [&self.password, &self.confirm] {
            input.update(cx, |input, cx| {
                input.set_masked(!self.show_password, window, cx)
            });
        }
        cx.notify();
    }

    fn submit_button(
        id: &'static str,
        loading: bool,
        idle: &'static str,
        busy: &'static str,
    ) -> Button {
        Button::new(id)
            .primary()
            .large()
            .disabled(loading)
            .when(loading, |b| b.loading(true).label(busy))
            .when(!loading, |b| {
                b.child(
                    div()
                        .flex()
                        .items_center()
                        .gap_2()
                        .child(idle)
                        .child(icon("arrow-right").size_4()),
                )
            })
    }

    fn render_request(&mut self, cx: &mut Context<Self>) -> Div {
        div()
            .flex()
            .flex_col()
            .gap_4()
            .child(field(
                ui::label("Home server"),
                "server",
                Input::new(&self.home_server),
                &self.request_errors[0],
                cx,
            ))
            .child(field(
                ui::label("Email"),
                "mail",
                Input::new(&self.email_input),
                &self.request_errors[1],
                cx,
            ))
            .child(
                Self::submit_button(
                    "send-code",
                    self.request_loading,
                    "Send reset code",
                    "Sending code...",
                )
                .w_full()
                .on_click(cx.listener(|this, _, window, cx| this.request(window, cx))),
            )
            .when(!self.request_error.is_empty(), |form| {
                form.child(ui::error_text(self.request_error.clone(), cx))
            })
    }

    fn render_reset(&mut self, cx: &mut Context<Self>) -> Div {
        let t = theme::tokens(cx);
        let eye = div()
            .id("toggle-password")
            .text_color(t.muted_foreground)
            .hover(|s| s.text_color(t.foreground))
            .cursor_pointer()
            .child(icon(if self.show_password { "eye-off" } else { "eye" }).size_4())
            .on_click(cx.listener(|this, _, window, cx| this.toggle_password(window, cx)));
        div()
            .flex()
            .flex_col()
            .gap_4()
            .child(field(
                ui::label("Verification code"),
                "key-round",
                Input::new(&self.code).font_family(cx.theme().mono_font_family.clone()),
                &self.reset_errors[0],
                cx,
            ))
            .child(field(
                ui::label("New password"),
                "lock",
                Input::new(&self.password).suffix(eye),
                &self.reset_errors[1],
                cx,
            ))
            .child(field(
                ui::label("Confirm new password"),
                "lock",
                Input::new(&self.confirm),
                &self.reset_errors[2],
                cx,
            ))
            .child(
                div()
                    .flex()
                    .gap_2()
                    .child(
                        Button::new("back")
                            .ghost()
                            .large()
                            .icon(icon("arrow-left"))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.step = Step::Request;
                                this.reset_error.clear();
                                cx.notify();
                            })),
                    )
                    .child(
                        Self::submit_button(
                            "update",
                            self.reset_loading,
                            "Update password",
                            "Updating password...",
                        )
                        .flex_1()
                        .min_w_0()
                        .on_click(cx.listener(|this, _, window, cx| this.reset(window, cx))),
                    ),
            )
            .when(!self.reset_error.is_empty(), |form| {
                form.child(ui::error_text(self.reset_error.clone(), cx))
            })
    }

    fn render_complete(&mut self) -> Div {
        let login_href = self.login_href.clone();
        div()
            .flex()
            .flex_col()
            .gap_5()
            .child(
                div()
                    .flex()
                    .items_start()
                    .gap_3()
                    .border_1()
                    .border_color(emerald(400).opacity(0.2))
                    .bg(emerald(400).opacity(0.05))
                    .p_3()
                    .text_sm()
                    .text_color(emerald(300))
                    .child(icon("circle-check").mt(px(2.0)).size_4().flex_shrink_0())
                    .child("You can now sign in with your new password."),
            )
            .child(
                Button::new("return")
                    .primary()
                    .large()
                    .w_full()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .child("Return to sign in")
                            .child(icon("arrow-right").size_4()),
                    )
                    .on_click(move |_, _, cx| router::goto(&login_href, cx)),
            )
    }
}

impl Render for ResetPasswordPage {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        let header = match self.step {
            Step::Request => div()
                .px_6()
                .mt_2()
                .flex()
                .flex_col()
                .gap_1()
                .text_center()
                .child(
                    div()
                        .text_xl()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child("Reset your password"),
                )
                .child(
                    div()
                        .text_sm()
                        .text_color(t.muted_foreground)
                        .child("Enter your account email and a 6-digit code will be sent to you."),
                ),
            Step::Reset => card_header(
                "Check your inbox",
                Some(
                    div()
                        .child(
                            StyledText::new(format!(
                                "Enter the code sent to {}. It expires in 10 minutes.",
                                self.email
                            ))
                            .with_highlights([(
                                "Enter the code sent to ".len()
                                    .."Enter the code sent to ".len() + self.email.len(),
                                HighlightStyle {
                                    color: Some(t.foreground),
                                    ..Default::default()
                                },
                            )]),
                        )
                        .into_any_element(),
                ),
            ),
            Step::Complete => card_header("Password updated!", None),
        };
        let content = match self.step {
            Step::Request => self.render_request(cx),
            Step::Reset => self.render_reset(cx),
            Step::Complete => self.render_complete(),
        };
        let login_href = self.login_href.clone();
        let card = auth_card(0.85, cx)
            .child(header)
            .child(div().px_6().child(content))
            .when(self.step != Step::Complete, |card| {
                card.child(footer_link(
                    "Remember your password?",
                    "sign-in",
                    "Sign in",
                    move |_, _, cx| router::goto(&login_href, cx),
                ))
            });
        auth_page(card, true, None, cx)
    }
}
