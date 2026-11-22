// A plain element as a Popover / DropdownMenu trigger (bits-ui's `Trigger` with custom children):
// gpui-component wants a `Selectable` trigger, which only its own widgets are.
use gpui_kit::component::{Selectable, menu::DropdownMenu};

use crate::prelude::*;

#[derive(IntoElement)]
pub struct Trigger {
    base: Stateful<Div>,
    open: bool,
}

/// `div().id(id)` to style as the trigger.
pub fn trigger(id: impl Into<ElementId>) -> Trigger {
    Trigger {
        base: div().id(id),
        open: false,
    }
}

impl Selectable for Trigger {
    fn selected(mut self, selected: bool) -> Self {
        self.open = selected;
        self
    }

    fn is_selected(&self) -> bool {
        self.open
    }
}

impl Styled for Trigger {
    fn style(&mut self) -> &mut StyleRefinement {
        self.base.style()
    }
}

impl InteractiveElement for Trigger {
    fn interactivity(&mut self) -> &mut Interactivity {
        self.base.interactivity()
    }
}

impl StatefulInteractiveElement for Trigger {}

impl ParentElement for Trigger {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.base.extend(elements);
    }
}

impl DropdownMenu for Trigger {}

impl RenderOnce for Trigger {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        self.base
    }
}
