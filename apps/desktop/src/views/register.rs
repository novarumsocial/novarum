// Port of apps/frontend/src/routes/register/+page.svelte.
use crate::prelude::*;
use gpui_kit::component::{
    ActiveTheme,
    input::{Input, InputEvent, InputState},
};

use crate::{
    api,
    state::{
        router::{self, Router},
        session::{LoginResult, Session},
    },
    theme,
    ui::{self, icon},
    views::{
        auth::{auth_backdrop, field},
        auth_card::{check_hint, validate_email, validate_passwords},
        login::{validate_home_server, validate_username},
    },
};

const USERNAME: usize = 0;
const HOME_SERVER: usize = 1;
const DISPLAY_NAME: usize = 2;
const EMAIL: usize = 3;
const PASSWORD: usize = 4;
const CONFIRM: usize = 5;

pub struct RegisterPage {
    inputs: [Entity<InputState>; 6],
    errors: [Option<String>; 6],
    loading: bool,
    show_password: bool,
    submit_error: String,
    redirect: Option<String>,
    _subscriptions: Vec<Subscription>,
}

/// `registerSchema`'s check for one field, given every field's value.
fn validate(field: usize, values: &[String; 6]) -> Option<&'static str> {
    match field {
        USERNAME => validate_username(&values[USERNAME]),
        HOME_SERVER => validate_home_server(&values[HOME_SERVER]),
        DISPLAY_NAME => {
            (values[DISPLAY_NAME].trim().chars().count() > 64).then_some("At most 64 characters.")
        }
        EMAIL => validate_email(&values[EMAIL]),
        PASSWORD => validate_passwords(&values[PASSWORD], &values[CONFIRM])[0],
        _ => validate_passwords(&values[PASSWORD], &values[CONFIRM])[1],
    }
}

impl RegisterPage {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let input = |placeholder: &str, window: &mut Window, cx: &mut Context<Self>| {
            let placeholder = placeholder.to_string();
            cx.new(|cx| InputState::new(window, cx).placeholder(placeholder))
        };
        let inputs = [
            input("alice", window, cx),
            cx.new(|cx| {
                InputState::new(window, cx)
                    .placeholder("novarum.me")
                    .default_value(api::anchor().home_server)
            }),
            cx.new(|cx| {
                InputState::new(window, cx)
                    .placeholder("Alice")
                    .validate(|value, _| value.chars().count() <= 64)
            }),
            input("you@example.com", window, cx),
            cx.new(|cx| {
                InputState::new(window, cx)
                    .placeholder("At least 8 characters")
                    .masked(true)
            }),
            cx.new(|cx| {
                InputState::new(window, cx)
                    .placeholder("Re-enter your password")
                    .masked(true)
            }),
        ];

        let subscriptions = inputs
            .iter()
            .enumerate()
            .map(|(index, input)| {
                cx.subscribe_in(
                    input,
                    window,
                    move |this, _, event: &InputEvent, window, cx| match event {
                        // `validationMethod: 'oninput'`
                        InputEvent::Change => {
                            this.errors[index] = validate(index, &this.values(cx)).map(Into::into);
                            cx.notify();
                        }
                        InputEvent::PressEnter { .. } => this.submit(window, cx),
                        _ => {}
                    },
                )
            })
            .collect();

        Self {
            inputs,
            errors: Default::default(),
            loading: false,
            show_password: false,
            submit_error: String::new(),
            redirect: Router::global(cx).read(cx).param("redirect"),
            _subscriptions: subscriptions,
        }
    }

    fn values(&self, cx: &App) -> [String; 6] {
        self.inputs
            .each_ref()
            .map(|input| input.read(cx).value().to_string())
    }

    fn submit(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        if self.loading {
            return;
        }
        let values = self.values(cx);
        self.errors = std::array::from_fn(|index| validate(index, &values).map(Into::into));
        self.submit_error.clear();
        if self.errors.iter().any(Option::is_some) {
            cx.notify();
            return;
        }
        self.loading = true;
        cx.notify();

        let [username, home_server, display_name, email, password, _] = values;
        let signup = Session::signup(
            home_server.trim().into(),
            username.trim().into(),
            Some(display_name.trim().into()),
            email,
            password,
            cx,
        );
        cx.spawn(async move |this, cx| {
            let result = signup.await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    LoginResult::Ok(_) => {
                        crate::app::restart_session(cx);
                        router::goto(router::safe_redirect(this.redirect.as_deref()), cx);
                    }
                    LoginResult::Err(error) => this.submit_error = error,
                    LoginResult::Mfa { .. } => {}
                }
                this.loading = false;
                cx.notify();
            });
        })
        .detach();
    }

    fn toggle_password(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.show_password = !self.show_password;
        for input in [&self.inputs[PASSWORD], &self.inputs[CONFIRM]] {
            input.update(cx, |input, cx| {
                input.set_masked(!self.show_password, window, cx)
            });
        }
        cx.notify();
    }

    /// A label with the red `*` of required fields.
    fn required(text: &str, cx: &App) -> Div {
        ui::label(text.to_string())
            .flex()
            .items_center()
            .gap_2()
            .child(div().text_color(theme::tokens(cx).destructive).child("*"))
    }
}

impl Render for RegisterPage {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        let values = self.values(cx);
        let handle = format!(
            "@{}:{}",
            if values[USERNAME].is_empty() {
                "username"
            } else {
                &values[USERNAME]
            },
            if values[HOME_SERVER].is_empty() {
                "server"
            } else {
                &values[HOME_SERVER]
            },
        );
        let eye = div()
            .id("toggle-password")
            .text_color(t.muted_foreground)
            .hover(|s| s.text_color(t.foreground))
            .cursor_pointer()
            .child(icon(if self.show_password { "eye-off" } else { "eye" }).size_4())
            .on_click(cx.listener(|this, _, window, cx| this.toggle_password(window, cx)));

        let content = div()
            .flex()
            .flex_col()
            .gap_4()
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(
                        div()
                            .flex()
                            .gap_3()
                            .child(
                                field(
                                    Self::required("Username", cx),
                                    "at-sign",
                                    Input::new(&self.inputs[USERNAME]),
                                    &self.errors[USERNAME],
                                    cx,
                                )
                                .flex_1()
                                .min_w_0(),
                            )
                            .child(
                                field(
                                    Self::required("Home server", cx),
                                    "server",
                                    Input::new(&self.inputs[HOME_SERVER]),
                                    &self.errors[HOME_SERVER],
                                    cx,
                                )
                                .flex_1()
                                .min_w_0(),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .gap_1()
                            .text_xs()
                            .text_color(t.muted_foreground)
                            .child("Handle preview:")
                            .child(
                                div()
                                    .min_w_0()
                                    .font_family(cx.theme().mono_font_family.clone())
                                    .text_color(t.foreground)
                                    .child(handle),
                            ),
                    ),
            )
            .child(field(
                ui::label("Display name")
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(div().text_color(t.muted_foreground).child("(optional)")),
                "user",
                Input::new(&self.inputs[DISPLAY_NAME]),
                &self.errors[DISPLAY_NAME],
                cx,
            ))
            .child(field(
                Self::required("Email", cx),
                "mail",
                Input::new(&self.inputs[EMAIL]),
                &self.errors[EMAIL],
                cx,
            ))
            .child(
                field(
                    Self::required("Password", cx),
                    "lock",
                    Input::new(&self.inputs[PASSWORD]).suffix(eye),
                    &self.errors[PASSWORD],
                    cx,
                )
                .when(values[PASSWORD].chars().count() >= 8, |field| {
                    field.child(check_hint("Looks good"))
                }),
            )
            .child(
                field(
                    Self::required("Confirm password", cx),
                    "lock",
                    Input::new(&self.inputs[CONFIRM]),
                    &self.errors[CONFIRM],
                    cx,
                )
                .when(
                    !values[CONFIRM].is_empty() && values[CONFIRM] == values[PASSWORD],
                    |field| field.child(check_hint("Matches")),
                ),
            )
            .child(
                Button::new("create-account")
                    .primary()
                    .large()
                    .w_full()
                    .disabled(self.loading)
                    .when(self.loading, |b| b.loading(true).label("Creating account…"))
                    .when(!self.loading, |b| {
                        b.child(
                            div()
                                .flex()
                                .items_center()
                                .gap_2()
                                .child("Create account")
                                .child(icon("arrow-right").size_4()),
                        )
                    })
                    .on_click(cx.listener(|this, _, window, cx| this.submit(window, cx))),
            )
            .when(!self.submit_error.is_empty(), |form| {
                form.child(ui::error_text(self.submit_error.clone(), cx))
            });

        let footer = div().flex().child("Already have an account?").child(
            div()
                .id("sign-in")
                .ml_1()
                .font_weight(FontWeight::MEDIUM)
                .text_color(t.foreground)
                .cursor_pointer()
                .hover(|s| s.underline())
                .child("Sign in")
                .on_click(|_, _, cx| router::goto("/login", cx)),
        );

        auth_backdrop(
            "Create your account",
            "Pick a home server and username - your handle works across the federation.",
            content,
            footer,
            cx,
        )
    }
}
