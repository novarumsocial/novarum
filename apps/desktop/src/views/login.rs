// Port of apps/frontend/src/routes/login/+page.svelte.
use crate::prelude::*;
use gpui_kit::{
    component::{
        Sizable,
        button::{Button, ButtonVariants},
        input::{Input, InputEvent, InputState, OtpEvent, OtpInput, OtpState},
    },
    *,
};

use crate::{
    api,
    state::{
        router::{self, Router},
        session::{LoginResult, MfaMethod, Session},
    },
    theme,
    ui::{self, icon},
    views::auth::{auth_backdrop, field},
};

pub struct LoginPage {
    home_server: Entity<InputState>,
    username: Entity<InputState>,
    password: Entity<InputState>,
    otp: Entity<OtpState>,
    errors: [Option<String>; 3],
    loading: bool,
    submit_error: String,
    mfa_challenge: String,
    mfa_methods: Vec<MfaMethod>,
    mfa_method: MfaMethod,
    email_sent: bool,
    sending_email: bool,
    show_login_options: bool,
    redirect: Option<String>,
    _subscriptions: Vec<Subscription>,
}

/// The `loginSchema` checks, in order. `None` when the field is fine.
fn validate_home_server(value: &str) -> Option<&'static str> {
    let value = value.trim();
    if value.is_empty() {
        return Some("Pick a home server.");
    }
    let host = value.strip_prefix("https://").or_else(|| value.strip_prefix("http://")).unwrap_or(value);
    let (host, port) = match host.rsplit_once(':') {
        Some((host, port)) if !host.ends_with(']') || host.starts_with('[') => (host, Some(port)),
        _ => (host, None),
    };
    let port_ok = port.is_none_or(|port| (1..=5).contains(&port.len()) && port.chars().all(|c| c.is_ascii_digit()));
    let named = host.rsplit_once('.').is_some_and(|(name, tld)| {
        !name.is_empty()
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
            && tld.len() >= 2
            && tld.chars().all(|c| c.is_ascii_alphabetic())
    });
    let local = matches!(host, "localhost" | "127.0.0.1" | "[::1]");
    if (named || local) && port_ok { None } else { Some("Enter a valid server address.") }
}

pub fn validate_username(value: &str) -> Option<&'static str> {
    let value = value.trim();
    if value.chars().count() < 2 {
        Some("At least 2 characters.")
    } else if value.chars().count() > 32 {
        Some("At most 32 characters.")
    } else if !value.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_') {
        Some("Letters, numbers, dots, underscores only.")
    } else {
        None
    }
}

impl LoginPage {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let home_server = cx.new(|cx| {
            InputState::new(window, cx).placeholder("novarum.me").default_value(api::anchor().home_server)
        });
        let username = cx.new(|cx| InputState::new(window, cx).placeholder("alice"));
        let password = cx.new(|cx| InputState::new(window, cx).placeholder("••••••••").masked(true));
        let otp = cx.new(|cx| OtpState::new(6, window, cx));

        let mut subscriptions = Vec::new();
        for input in [&home_server, &username, &password] {
            subscriptions.push(cx.subscribe_in(input, window, |this, _, event: &InputEvent, window, cx| {
                if let InputEvent::PressEnter { .. } = event {
                    this.submit(window, cx);
                }
            }));
        }
        subscriptions.push(cx.subscribe_in(&otp, window, |this, otp, event: &OtpEvent, window, cx| {
            if *event == OtpEvent::Complete && otp.read(cx).value().len() == 6 {
                this.verify_mfa(window, cx);
            }
            cx.notify();
        }));

        let router = Router::global(cx).read(cx);
        let redirect = router.param("redirect");
        let adding = router.param("add").is_some();

        if !adding {
            let redirect = redirect.clone();
            let refresh = Session::refresh(cx);
            cx.spawn(async move |_, cx| {
                if refresh.await.is_some() {
                    let _ = cx.update(|cx| router::goto(router::safe_redirect(redirect.as_deref()), cx));
                }
            })
            .detach();
        }

        Self {
            home_server,
            username,
            password,
            otp,
            errors: Default::default(),
            loading: false,
            submit_error: String::new(),
            mfa_challenge: String::new(),
            mfa_methods: Vec::new(),
            mfa_method: MfaMethod::Email,
            email_sent: false,
            sending_email: false,
            show_login_options: false,
            redirect,
            _subscriptions: subscriptions,
        }
    }

    fn submit(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        if self.loading {
            return;
        }
        let home_server = self.home_server.read(cx).value().trim().to_string();
        let username = self.username.read(cx).value().trim().to_string();
        let password = self.password.read(cx).value().to_string();
        self.errors = [
            validate_home_server(&home_server).map(Into::into),
            validate_username(&username).map(Into::into),
            password.is_empty().then(|| "Enter your password.".into()),
        ];
        self.submit_error.clear();
        if self.errors.iter().any(Option::is_some) {
            cx.notify();
            return;
        }
        self.loading = true;
        cx.notify();

        let login = Session::login(home_server, username, password, cx);
        cx.spawn(async move |this, cx| {
            let result = login.await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    LoginResult::Err(error) => this.submit_error = error,
                    LoginResult::Mfa { challenge, methods } => {
                        this.mfa_method = if methods.contains(&MfaMethod::Totp) { MfaMethod::Totp } else { MfaMethod::Email };
                        this.mfa_challenge = challenge;
                        this.mfa_methods = methods;
                    }
                    LoginResult::Ok(_) => {
                        crate::app::restart_session(cx);
                        router::goto(router::safe_redirect(this.redirect.as_deref()), cx);
                    }
                }
                this.loading = false;
                cx.notify();
            });
        })
        .detach();
    }

    fn verify_mfa(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        let code = self.otp.read(cx).value().to_string();
        if code.len() != 6 || !code.chars().all(|c| c.is_ascii_digit()) {
            self.submit_error = "Enter the six-digit verification code.".into();
            cx.notify();
            return;
        }
        if self.loading {
            return;
        }
        self.loading = true;
        self.submit_error.clear();
        cx.notify();
        let verify = Session::complete_mfa(self.mfa_challenge.clone(), self.mfa_method, code, cx);
        cx.spawn(async move |this, cx| {
            let result = verify.await;
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

    fn send_email_code(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.sending_email = true;
        self.submit_error.clear();
        cx.notify();
        let challenge = self.mfa_challenge.clone();
        cx.spawn_in(window, async move |this, cx| {
            let result = Session::send_mfa_email(challenge).await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.sending_email = false;
                match result {
                    Err(error) => this.submit_error = error,
                    Ok(()) => {
                        this.email_sent = true;
                        this.otp.update(cx, |otp, cx| otp.set_value("", window, cx));
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn select_mfa_method(&mut self, method: MfaMethod, window: &mut Window, cx: &mut Context<Self>) {
        self.mfa_method = method;
        self.otp.update(cx, |otp, cx| otp.set_value("", window, cx));
        self.submit_error.clear();
        self.show_login_options = false;
        cx.notify();
    }

    fn restart_login(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.mfa_challenge.clear();
        self.mfa_methods.clear();
        self.otp.update(cx, |otp, cx| otp.set_value("", window, cx));
        self.email_sent = false;
        self.show_login_options = false;
        self.submit_error.clear();
        cx.notify();
    }

    fn render_mfa(&mut self, cx: &mut Context<Self>) -> Div {
        let t = theme::tokens(cx);
        let code_len = self.otp.read(cx).value().len();
        let panel = || {
            div()
                .flex()
                .flex_col()
                .border_1()
                .border_color(white().opacity(0.1))
                .bg(t.background.opacity(0.35))
                .rounded(t.radius)
        };
        let option = |id: &'static str, icon_name: &str, title: &str, detail: &str, method: MfaMethod| {
            Button::new(id)
                .ghost()
                .w_full()
                .h_auto()
                .px_3()
                .py(px(10.0))
                .justify_start()
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap_3()
                        .child(icon(icon_name).size_4())
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .items_start()
                                .child(div().text_sm().child(title.to_string()))
                                .child(div().text_xs().text_color(t.muted_foreground).child(detail.to_string())),
                        ),
                )
                .on_click(cx.listener(move |this, _, window, cx| this.select_mfa_method(method, window, cx)))
        };

        let mut form = div().flex().flex_col().gap_5();
        if self.show_login_options {
            form = form.child(
                panel()
                    .gap_2()
                    .p_2()
                    .child(
                        div()
                            .px_2()
                            .pt_1()
                            .text_xs()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(t.muted_foreground)
                            .child("Choose how to verify"),
                    )
                    .when(self.mfa_methods.contains(&MfaMethod::Totp), |panel| {
                        panel.child(option("totp", "smartphone", "Authenticator app", "Use a rotating code", MfaMethod::Totp))
                    })
                    .when(self.mfa_methods.contains(&MfaMethod::Email), |panel| {
                        panel.child(option("email", "mail", "Email code", "Send a one-time code", MfaMethod::Email))
                    }),
            );
        } else if self.mfa_method == MfaMethod::Email && !self.email_sent {
            form = form.child(
                panel()
                    .gap_3()
                    .p_4()
                    .items_center()
                    .child(icon("mail").size_6().text_color(t.primary))
                    .child(
                        div().text_sm().text_center().text_color(t.muted_foreground).child(
                            "Ready? Click that fancy button below to send a one-time code to the email on your account.",
                        ),
                    )
                    .child(
                        Button::new("send-email")
                            .primary()
                            .w_full()
                            .disabled(self.sending_email)
                            .when(self.sending_email, |b| b.loading(true).label("Sending…"))
                            .when(!self.sending_email, |b| b.icon(icon("mail")).label("Send email code"))
                            .on_click(cx.listener(|this, _, window, cx| this.send_email_code(window, cx))),
                    ),
            );
        } else {
            form = form
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_3()
                        .items_center()
                        .child(div().text_sm().font_weight(FontWeight::MEDIUM).child("Verification code"))
                        .child(OtpInput::new(&self.otp).disabled(self.loading)),
                )
                .child(
                    Button::new("verify")
                        .primary()
                        .large()
                        .w_full()
                        .disabled(self.loading || code_len != 6)
                        .when(self.loading, |b| b.loading(true).label("Verifying…"))
                        .when(!self.loading, |b| {
                            b.child(div().flex().items_center().gap_2().child("Verify and sign in").child(icon("arrow-right").size_4()))
                        })
                        .on_click(cx.listener(|this, _, window, cx| this.verify_mfa(window, cx))),
                )
                .when(self.mfa_method == MfaMethod::Email, |form| {
                    form.child(
                        Button::new("resend")
                            .ghost()
                            .small()
                            .w_full()
                            .text_color(t.muted_foreground)
                            .disabled(self.sending_email)
                            .label(if self.sending_email { "Sending…" } else { "Send a new code" })
                            .on_click(cx.listener(|this, _, window, cx| this.send_email_code(window, cx))),
                    )
                });
        }

        form.when(self.mfa_methods.len() > 1 && !self.show_login_options, |form| {
            form.child(
                Button::new("another-way")
                    .outline()
                    .w_full()
                    .label("Try another way")
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.show_login_options = true;
                        cx.notify();
                    })),
            )
        })
        .when(!self.submit_error.is_empty(), |form| {
            form.child(ui::error_text(self.submit_error.clone(), cx).text_center())
        })
    }

    fn render_form(&mut self, cx: &mut Context<Self>) -> Div {
        let t = theme::tokens(cx);
        let redirect = self.redirect.clone();
        div()
            .flex()
            .flex_col()
            .gap_4()
            .child(field(ui::label("Home server"), "server", Input::new(&self.home_server), &self.errors[0], cx))
            .child(field(ui::label("Username"), "at-sign", Input::new(&self.username), &self.errors[1], cx))
            .child(field(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(ui::label("Password"))
                    .child(
                        div()
                            .id("forgot")
                            .text_xs()
                            .text_color(t.muted_foreground)
                            .hover(|s| s.text_color(t.foreground))
                            .cursor_pointer()
                            .child("Forgot password?")
                            .on_click(move |_, _, cx| {
                                router::goto(match &redirect {
                                    Some(redirect) => format!(
                                        "/reset-password?redirect={}",
                                        router::encode(&router::safe_redirect(Some(redirect)))
                                    ),
                                    None => "/reset-password".into(),
                                }, cx)
                            }),
                    ),
                "lock",
                Input::new(&self.password),
                &self.errors[2],
                cx,
            ))
            .child(
                Button::new("sign-in")
                    .primary()
                    .large()
                    .w_full()
                    .disabled(self.loading)
                    .when(self.loading, |b| b.loading(true).label("Signing in…"))
                    .when(!self.loading, |b| {
                        b.child(div().flex().items_center().gap_2().child("Sign in").child(icon("log-in").size_4()))
                    })
                    .on_click(cx.listener(|this, _, window, cx| this.submit(window, cx))),
            )
            .when(!self.submit_error.is_empty(), |form| form.child(ui::error_text(self.submit_error.clone(), cx)))
    }
}

impl Render for LoginPage {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        let mfa = !self.mfa_challenge.is_empty();
        let description = if mfa {
            match (self.mfa_method, self.email_sent) {
                (MfaMethod::Email, true) => "Enter the code sent to the email on your account.",
                (MfaMethod::Email, false) => "Get a one-time code sent to the email on your account.",
                (MfaMethod::Totp, _) => "Enter the current code from your authenticator app.",
            }
        } else {
            "Sign in to your home server to continue."
        };
        let content = if mfa { self.render_mfa(cx) } else { self.render_form(cx) };
        let redirect = router::safe_redirect(self.redirect.as_deref());

        let footer = if mfa {
            div().child(
                div()
                    .id("back")
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .cursor_pointer()
                    .hover(|s| s.text_color(t.foreground))
                    .child(icon("arrow-left").size(px(14.0)))
                    .child("Back to sign in")
                    .on_click(cx.listener(|this, _, window, cx| this.restart_login(window, cx))),
            )
        } else {
            div().flex().child("Don't have an account?").child(
                div()
                    .id("register")
                    .ml_1()
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(t.foreground)
                    .cursor_pointer()
                    .hover(|s| s.underline())
                    .child("Register")
                    .on_click(move |_, _, cx| router::goto(format!("/register?redirect={redirect}"), cx)),
            )
        };

        auth_backdrop(
            if mfa { "Verify it’s you" } else { "Welcome back" },
            description,
            content,
            footer,
            cx,
        )
    }
}
