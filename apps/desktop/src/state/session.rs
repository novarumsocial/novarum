// Port of apps/frontend/src/lib/session.svelte.ts.
use gpui_kit::*;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{api, runtime, storage};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUser {
    pub id: String,
    pub username: String,
    pub homeserver: String,
    pub handle: String,
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub avatar_color: Option<String>,
    #[serde(default)]
    pub speaking_ring_color: Option<String>,
    #[serde(default)]
    pub banner_url: Option<String>,
    #[serde(default)]
    pub about: Option<String>,
    #[serde(default)]
    pub is_bot: bool,
}

impl SessionUser {
    pub fn name(&self) -> &str {
        self.display_name
            .as_deref()
            .filter(|name| !name.is_empty())
            .unwrap_or(&self.username)
    }

    pub fn as_public(&self) -> crate::models::PublicUser {
        crate::models::PublicUser {
            user_id: self.id.clone(),
            username: self.username.clone(),
            homeserver: self.homeserver.clone(),
            display_name: self.display_name.clone(),
            avatar_url: self.avatar_url.clone(),
            avatar_color: self.avatar_color.clone(),
            speaking_ring_color: self.speaking_ring_color.clone(),
            banner_url: self.banner_url.clone(),
            about: self.about.clone(),
            is_bot: self.is_bot,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub home_server: String,
    pub username: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub avatar_color: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum MfaMethod {
    Email,
    Totp,
}

pub enum LoginResult {
    Ok(SessionUser),
    Mfa {
        challenge: String,
        methods: Vec<MfaMethod>,
    },
    Err(String),
}

#[derive(Deserialize)]
struct MePayload {
    user: Option<SessionUser>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginResponse {
    #[serde(default)]
    mfa_required: bool,
    challenge: Option<String>,
    #[serde(default)]
    methods: Vec<MfaMethod>,
}

const ACCOUNTS_KEY: &str = "novarum:accounts";

pub struct Session {
    pub user: Option<SessionUser>,
    /// One per homeserver: the session cookie is shared by every account on the same server.
    pub accounts: Vec<Account>,
    pub loading: bool,
    pub initialized: bool,
    pub error: Option<String>,
}

struct GlobalSession(Entity<Session>);
impl Global for GlobalSession {}

pub fn init(cx: &mut App) {
    let session = cx.new(|_| Session {
        user: None,
        accounts: storage::get(ACCOUNTS_KEY).unwrap_or_default(),
        loading: false,
        initialized: false,
        error: None,
    });
    cx.set_global(GlobalSession(session));
}

impl Session {
    pub fn global(cx: &App) -> Entity<Self> {
        cx.global::<GlobalSession>().0.clone()
    }

    pub fn user(cx: &App) -> Option<SessionUser> {
        Self::global(cx).read(cx).user.clone()
    }

    /// Fetches `/auth/me`. Resolves to the signed-in user, if any.
    pub fn refresh(cx: &mut App) -> Task<Option<SessionUser>> {
        let this = Self::global(cx);
        this.update(cx, |session, cx| {
            session.loading = true;
            session.error = None;
            cx.notify();
        });
        let me = runtime::io(api::get::<MePayload>("/auth/me"));
        cx.spawn(async move |cx| {
            let result = me.await;
            this.update(cx, |session, cx| {
                session.user = match &result {
                    Ok(me) => me.user.clone(),
                    Err(error) if error.status == 401 => None,
                    Err(_) => {
                        session.error = Some("Could not load your session.".into());
                        None
                    }
                };
                if let Some(user) = session.user.clone() {
                    session.remember(&user);
                }
                session.initialized = true;
                session.loading = false;
                cx.notify();
                session.user.clone()
            })
        })
    }

    pub fn login(
        home_server: String,
        username: String,
        password: String,
        cx: &mut App,
    ) -> Task<LoginResult> {
        let this = Self::global(cx);
        cx.spawn(async move |cx| {
            if let Err(error) = api::set_home_server(&home_server).await {
                return LoginResult::Err(error);
            }
            let response = api::post::<LoginResponse>(
                "/auth/login",
                json!({ "username": username, "password": password }),
            )
            .await;
            match response {
                Err(error) => {
                    LoginResult::Err(api::error_message(&error.body, "Could not sign you in."))
                }
                Ok(data) if data.mfa_required => LoginResult::Mfa {
                    challenge: data.challenge.unwrap_or_default(),
                    methods: data.methods,
                },
                Ok(_) => Self::verify_new_session(this, "Sign-in", cx).await,
            }
        })
    }

    pub fn complete_mfa(
        challenge: String,
        method: MfaMethod,
        code: String,
        cx: &mut App,
    ) -> Task<LoginResult> {
        let this = Self::global(cx);
        cx.spawn(async move |cx| {
            let result = api::post::<api::Ignored>(
                "/auth/login/mfa",
                json!({ "challenge": challenge, "method": method, "code": code }),
            )
            .await;
            match result {
                Err(error) => LoginResult::Err(api::error_message(
                    &error.body,
                    "Could not verify that code.",
                )),
                Ok(_) => Self::verify_new_session(this, "Verification", cx).await,
            }
        })
    }

    pub async fn send_mfa_email(challenge: String) -> Result<(), String> {
        api::post::<api::Ignored>("/auth/login/mfa/email", json!({ "challenge": challenge }))
            .await
            .map(|_| ())
            .map_err(|error| api::error_message(&error.body, "Could not send the code."))
    }

    /// reset-password's first step: points the app at `home_server` and mails a code to `email`.
    pub async fn request_password_reset(home_server: String, email: String) -> Result<(), String> {
        api::set_home_server(&home_server).await?;
        api::post::<api::Ignored>("/auth/password-reset/request", json!({ "email": email }))
            .await
            .map(|_| ())
            .map_err(|error| api::error_message(&error.body, "Could not send the reset code."))
    }

    pub async fn reset_password(
        email: String,
        new_password: String,
        code: u32,
    ) -> Result<(), String> {
        api::post::<api::Ignored>(
            "/auth/reset-password",
            json!({ "email": email, "newPassword": new_password, "verificationCode": code }),
        )
        .await
        .map(|_| ())
        .map_err(|error| api::error_message(&error.body, "Could not reset your password."))
    }

    pub fn signup(
        home_server: String,
        username: String,
        display_name: Option<String>,
        email: String,
        password: String,
        cx: &mut App,
    ) -> Task<LoginResult> {
        let this = Self::global(cx);
        cx.spawn(async move |cx| {
            if let Err(error) = api::set_home_server(&home_server).await {
                return LoginResult::Err(error);
            }
            let result = api::post::<api::Ignored>(
                "/auth/signup",
                json!({
                    "username": username,
                    "displayName": display_name,
                    "email": email,
                    "password": password,
                }),
            )
            .await;
            match result {
                Err(error) => LoginResult::Err(api::error_message(
                    &error.body,
                    "Could not create your account.",
                )),
                Ok(_) => Self::verify_new_session(this, "Account creation", cx).await,
            }
        })
    }

    async fn verify_new_session(
        this: Entity<Self>,
        action: &str,
        cx: &mut AsyncApp,
    ) -> LoginResult {
        for attempt in 0..2 {
            if attempt > 0 {
                cx.background_executor()
                    .timer(std::time::Duration::from_secs(1))
                    .await;
            }
            match api::get::<MePayload>("/auth/me").await {
                Ok(MePayload { user: Some(user) }) => {
                    let _ = this.update(cx, |session, cx| {
                        session.user = Some(user.clone());
                        session.remember(&user);
                        session.initialized = true;
                        cx.notify();
                    });
                    return LoginResult::Ok(user);
                }
                Ok(_) if attempt == 1 => {
                    return LoginResult::Err(format!(
                        "{action} succeeded, but the server returned no authenticated session."
                    ));
                }
                Err(error) if attempt == 1 => {
                    return LoginResult::Err(if error.status == 401 {
                        format!(
                            "{action} succeeded, but the server could not verify the new session. Try again."
                        )
                    } else {
                        api::error_message(
                            &error.body,
                            &format!(
                                "{action} succeeded, but the server could not verify the new session."
                            ),
                        )
                    });
                }
                _ => {}
            }
        }
        unreachable!()
    }

    pub fn switch_account(home_server: String, cx: &mut App) {
        cx.spawn(async move |cx| {
            if api::set_home_server(&home_server).await.is_ok() {
                cx.update(|cx| crate::app::restart_session(cx));
            }
        })
        .detach();
    }

    pub fn forget(&mut self, home_server: &str, cx: &mut Context<Self>) {
        self.accounts
            .retain(|account| account.home_server != home_server);
        storage::set(ACCOUNTS_KEY, &self.accounts);
        cx.notify();
    }

    fn remember(&mut self, user: &SessionUser) {
        let home_server = api::anchor().home_server;
        self.accounts
            .retain(|account| account.home_server != home_server);
        self.accounts.push(Account {
            home_server,
            username: user.username.clone(),
            display_name: user.display_name.clone(),
            avatar_url: user.avatar_url.clone(),
            avatar_color: user.avatar_color.clone(),
        });
        storage::set(ACCOUNTS_KEY, &self.accounts);
    }

    pub fn logout(cx: &mut App) -> Task<()> {
        let this = Self::global(cx);
        cx.spawn(async move |cx| {
            let _ = api::post::<api::Ignored>("/auth/logout", json!({})).await;
            let _ = this.update(cx, |session, cx| {
                session.user = None;
                session.initialized = true;
                session.loading = false;
                cx.notify();
            });
        })
    }
}

/// User ids are per server, so a message from a federated guild or DM carries the remote one.
pub fn is_self(username: &str, server: &str, cx: &App) -> bool {
    Session::user(cx).is_some_and(|user| {
        format!("@{username}:{server}").to_lowercase() == user.handle.to_lowercase()
    })
}
