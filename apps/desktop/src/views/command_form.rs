// Port of apps/frontend/src/lib/components/command-form.svelte: the options of a slash command,
// filled in inside the composer. The web's Select pickers are dropdown menus here.
use std::{collections::HashMap, time::Duration};

use gpui_kit::component::{
    input::{Input, InputEvent, InputState},
    menu::{DropdownMenu, PopupMenuItem},
    switch::Switch,
};

use crate::prelude::*;

use crate::{
    state::{
        bots::{Choice, Command, CommandOption, CommandOptionInput, CommandOptionType, GuildBotCommands, Interactions, OptionValue},
        chat::Chat,
    },
    ui::avatar::avatar,
};

/// `String(value)` like JS: whole numbers without a decimal point.
pub fn value_text(value: &OptionValue) -> String {
    match value {
        OptionValue::Bool(value) => value.to_string(),
        OptionValue::Number(number) if number.fract() == 0.0 && number.abs() < 1e15 => format!("{}", *number as i64),
        OptionValue::Number(number) => number.to_string(),
        OptionValue::Text(text) => text.clone(),
    }
}

/// What the person typed for `option`, as the value sent to the bot. Empty means unset.
pub fn to_value(option: &CommandOption, raw: &str, checked: Option<bool>) -> Option<OptionValue> {
    match option.kind {
        CommandOptionType::Boolean => checked.map(OptionValue::Bool),
        _ if raw.is_empty() => None,
        CommandOptionType::Integer | CommandOptionType::Number => {
            raw.trim().parse::<f64>().ok().filter(|number| number.is_finite()).map(OptionValue::Number)
        }
        _ => Some(OptionValue::Text(raw.to_string())),
    }
}

pub enum CommandFormEvent {
    Close,
}

impl EventEmitter<CommandFormEvent> for CommandForm {}

pub struct CommandForm {
    entry: GuildBotCommands,
    command: Command,
    channel_id: String,
    /// text and number options without choices
    inputs: HashMap<String, Entity<InputState>>,
    /// picked choices and members, by option name
    picked: HashMap<String, String>,
    checked: HashMap<String, bool>,
    sending: bool,
    error: Option<String>,
    suggestions: (String, Vec<Choice>),
    autocomplete: Option<Task<()>>,
    focus: FocusHandle,
    _subscriptions: Vec<Subscription>,
}

fn free_text(option: &CommandOption) -> bool {
    !matches!(option.kind, CommandOptionType::Boolean | CommandOptionType::User)
        && option.choices.as_ref().is_none_or(Vec::is_empty)
}

impl CommandForm {
    pub fn new(
        entry: GuildBotCommands,
        command: Command,
        channel_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut inputs = HashMap::new();
        let mut subscriptions = Vec::new();
        for (index, option) in command.options.iter().enumerate().filter(|(_, option)| free_text(option)) {
            let input = cx.new(|cx| InputState::new(window, cx));
            if index == 0 {
                input.update(cx, |input, cx| input.focus(window, cx));
            }
            let name = option.name.clone();
            subscriptions.push(cx.subscribe_in(&input, window, move |this, _, event: &InputEvent, window, cx| {
                match event {
                    InputEvent::Change | InputEvent::Focus => this.ask_for_suggestions(&name, cx),
                    InputEvent::PressEnter { .. } => this.run(window, cx),
                    InputEvent::Blur => {}
                }
                cx.notify();
            }));
            inputs.insert(option.name.clone(), input);
        }
        let focus = cx.focus_handle();
        if inputs.is_empty() {
            window.focus(&focus, cx);
        }
        Self {
            entry,
            command,
            channel_id,
            inputs,
            picked: HashMap::new(),
            checked: HashMap::new(),
            sending: false,
            error: None,
            suggestions: (String::new(), vec![]),
            autocomplete: None,
            focus,
            _subscriptions: subscriptions,
        }
    }

    fn raw(&self, option: &CommandOption, cx: &App) -> String {
        match self.inputs.get(&option.name) {
            Some(input) => input.read(cx).value().to_string(),
            None => self.picked.get(&option.name).cloned().unwrap_or_default(),
        }
    }

    fn value(&self, option: &CommandOption, cx: &App) -> Option<OptionValue> {
        to_value(option, &self.raw(option, cx), self.checked.get(&option.name).copied())
    }

    fn missing(&self, cx: &App) -> Vec<String> {
        self.command
            .options
            .iter()
            .filter(|option| option.required && option.kind != CommandOptionType::Boolean && self.raw(option, cx).is_empty())
            .map(|option| option.name.clone())
            .collect()
    }

    fn filled(&self, skip: Option<&str>, cx: &App) -> Vec<CommandOptionInput> {
        self.command
            .options
            .iter()
            .filter(|option| Some(option.name.as_str()) != skip)
            .filter_map(|option| self.value(option, cx).map(|value| CommandOptionInput { name: option.name.clone(), value }))
            .collect()
    }

    fn ask_for_suggestions(&mut self, name: &str, cx: &mut Context<Self>) {
        let Some(option) = self.command.options.iter().find(|option| option.name == name) else { return };
        if option.autocomplete != Some(true) {
            return;
        }
        let mut options = self.filled(Some(name), cx);
        options.push(CommandOptionInput { name: name.into(), value: OptionValue::Text(self.raw(option, cx)) });
        let (channel_id, bot_id, command, name) =
            (self.channel_id.clone(), self.entry.bot.user_id.clone(), self.command.name.clone(), name.to_string());
        self.autocomplete = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(250)).await;
            let task = cx.update(|cx| {
                Interactions::global(cx).update(cx, |interactions, cx| {
                    interactions.autocomplete(channel_id, bot_id, command, options, name.clone(), cx)
                })
            });
            let choices = task.await;
            let _ = this.update(cx, |this, cx| {
                this.suggestions = (name, choices);
                cx.notify();
            });
        }));
    }

    fn run(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        if !self.missing(cx).is_empty() || self.sending {
            return;
        }
        self.sending = true;
        cx.notify();
        let options = self.filled(None, cx);
        let run = Interactions::global(cx).update(cx, |interactions, cx| {
            interactions.run_command(self.channel_id.clone(), &self.entry, self.command.name.clone(), options, cx)
        });
        cx.spawn(async move |this, cx| {
            let result = run.await;
            let _ = this.update(cx, |this, cx| {
                this.sending = false;
                match result {
                    Ok(()) => cx.emit(CommandFormEvent::Close),
                    Err(error) => this.error = Some(error),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn picker(&self, option: &CommandOption, cx: &mut Context<Self>) -> AnyElement {
        let name = option.name.clone();
        let current = self.picked.get(&name).cloned().unwrap_or_default();
        let (label, items): (String, Vec<(String, String)>) = if option.kind == CommandOptionType::User {
            let members = Chat::global(cx).read(cx).channel_members(cx);
            let label = members
                .iter()
                .find(|member| member.user_id == current)
                .map(|member| member.name().to_string())
                .unwrap_or_else(|| "Pick a member".into());
            (label, members.iter().map(|member| (member.user_id.clone(), member.name().to_string())).collect())
        } else {
            let choices = option.choices.clone().unwrap_or_default();
            let label = choices
                .iter()
                .find(|choice| value_text(&choice.value) == current)
                .map(|choice| choice.name.clone())
                .unwrap_or_else(|| "Choose one".into());
            (label, choices.iter().map(|choice| (value_text(&choice.value), choice.name.clone())).collect())
        };
        let this = cx.entity().downgrade();
        Button::new(SharedString::from(format!("pick-{name}")))
            .outline()
            .w_full()
            .justify_start()
            .label(label)
            .dropdown_caret(true)
            .dropdown_menu(move |mut menu, _, _| {
                for (value, label) in &items {
                    let (this, name, value) = (this.clone(), name.clone(), value.clone());
                    menu = menu.item(PopupMenuItem::new(label.clone()).on_click(move |_, _, cx| {
                        let _ = this.update(cx, |this, cx| {
                            this.picked.insert(name.clone(), value.clone());
                            cx.notify();
                        });
                    }));
                }
                menu
            })
            .into_any_element()
    }

    fn render_option(&self, option: &CommandOption, cx: &mut Context<Self>) -> Div {
        let t = theme::tokens(cx);
        let label = div()
            .text_xs()
            .font_weight(FontWeight::MEDIUM)
            .child(option.name.clone())
            .when(option.required, |label| label.child(div().text_color(t.destructive).child("*")))
            .child(div().ml_1().font_weight(FontWeight::NORMAL).text_color(t.muted_foreground).child(option.description.clone()))
            .flex()
            .flex_wrap();
        let name = option.name.clone();
        let control: AnyElement = if option.kind == CommandOptionType::Boolean {
            Switch::new(SharedString::from(format!("switch-{name}")))
                .checked(self.checked.get(&name).copied().unwrap_or(false))
                .on_click(cx.listener(move |this, checked: &bool, _, cx| {
                    this.checked.insert(name.clone(), *checked);
                    cx.notify();
                }))
                .into_any_element()
        } else if let Some(input) = self.inputs.get(&option.name) {
            let suggestions = (self.suggestions.0 == option.name && !self.suggestions.1.is_empty()).then(|| {
                let mut list = div().flex().flex_col().max_h_40().border_1().border_color(t.border).bg(t.popover).p_1();
                for (index, choice) in self.suggestions.1.iter().enumerate() {
                    let (input, value) = (input.clone(), value_text(&choice.value));
                    list = list.child(
                        div()
                            .id(SharedString::from(format!("suggestion-{name}-{index}")))
                            .truncate()
                            .px_2()
                            .py_1p5()
                            .text_xs()
                            .cursor_pointer()
                            .hover(|s| s.bg(t.muted))
                            .child(choice.name.clone())
                            .on_click(cx.listener(move |this, _, window, cx| {
                                input.update(cx, |input, cx| input.set_value(value.clone(), window, cx));
                                this.suggestions = (String::new(), vec![]);
                                cx.notify();
                            })),
                    );
                }
                list
            });
            div().flex().flex_col().gap_1().child(Input::new(input).small()).children(suggestions).into_any_element()
        } else {
            self.picker(option, cx)
        };
        div().flex().flex_col().min_w_0().gap_1().child(label).child(control)
    }
}

impl Render for CommandForm {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        let bot = self.entry.bot.clone();
        let missing = self.missing(cx);
        let wide = window.viewport_size().width >= px(640.0);
        let mut grid = div().flex().flex_wrap().gap_2();
        for option in self.command.options.clone() {
            grid = grid.child(
                div()
                    .min_w_0()
                    .when(wide, |cell| cell.w(relative(0.5)).flex_basis(relative(0.48)).flex_grow(1.0))
                    .when(!wide, |cell| cell.w_full())
                    .child(self.render_option(&option, cx)),
            );
        }
        div()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|_, event: &KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" {
                    cx.emit(CommandFormEvent::Close);
                }
            }))
            .flex()
            .flex_col()
            .gap_2()
            .p_2()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(avatar(bot.avatar_url.as_deref(), bot.name(), bot.avatar_color.as_deref(), 20.0, cx))
                    .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child(format!("/{}", self.command.name)))
                    .child(div().min_w_0().truncate().text_xs().text_color(t.muted_foreground).child(self.command.description.clone()))
                    .child(
                        div()
                            .id("close-command")
                            .ml_auto()
                            .flex()
                            .size_6()
                            .flex_shrink_0()
                            .items_center()
                            .justify_center()
                            .cursor_pointer()
                            .hover(|s| s.bg(t.muted))
                            .child(icon("x").size_3())
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(CommandFormEvent::Close))),
                    ),
            )
            .when(!self.command.options.is_empty(), |form| form.child(grid))
            .when_some(self.error.clone(), |form, error| form.child(div().text_xs().text_color(t.destructive).child(error)))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_end()
                    .gap_2()
                    .when(!missing.is_empty(), |row| {
                        row.child(div().text_xs().text_color(t.muted_foreground).child(format!("Fill in {}", missing.join(", "))))
                    })
                    .child(
                        Button::new("use-command")
                            .primary()
                            .small()
                            .disabled(!missing.is_empty() || self.sending)
                            .loading(self.sending)
                            .when(!self.sending, |button| button.icon(icon("send-horizontal")))
                            .label(format!("Use /{}", self.command.name))
                            .on_click(cx.listener(|this, _, window, cx| this.run(window, cx))),
                    ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::{to_value, value_text};
    use crate::state::bots::{CommandOption, CommandOptionType, OptionValue};

    fn option(kind: CommandOptionType) -> CommandOption {
        CommandOption {
            name: "o".into(),
            description: String::new(),
            kind,
            required: false,
            choices: None,
            autocomplete: None,
            min_value: None,
            max_value: None,
            min_length: None,
            max_length: None,
        }
    }

    #[test]
    fn converts_typed_values() {
        assert_eq!(to_value(&option(CommandOptionType::String), "", None), None);
        assert_eq!(to_value(&option(CommandOptionType::String), "hi", None), Some(OptionValue::Text("hi".into())));
        assert_eq!(to_value(&option(CommandOptionType::Integer), "6", None), Some(OptionValue::Number(6.0)));
        assert_eq!(to_value(&option(CommandOptionType::Number), "abc", None), None);
        assert_eq!(to_value(&option(CommandOptionType::Boolean), "", Some(true)), Some(OptionValue::Bool(true)));
        assert_eq!(to_value(&option(CommandOptionType::Boolean), "", None), None);
    }

    #[test]
    fn prints_values_like_js() {
        assert_eq!(value_text(&OptionValue::Number(6.0)), "6");
        assert_eq!(value_text(&OptionValue::Number(6.5)), "6.5");
        assert_eq!(value_text(&OptionValue::Text("x".into())), "x");
    }
}
