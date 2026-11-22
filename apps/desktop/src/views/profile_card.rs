// Port of apps/frontend/src/lib/components/profile-card.svelte. Stub until ported: wraps `trigger`
// so clicking it opens the user's card in a popover.
use std::rc::Rc;

use crate::{models::Author, prelude::*};

/// `onCall(channelId)`: start a call from the card's "Call" button.
pub type OnCall = Rc<dyn Fn(&str, &mut Window, &mut App)>;

pub fn profile_card(
    id: impl Into<ElementId>,
    user: Author,
    on_call: Option<OnCall>,
    trigger: impl IntoElement,
) -> AnyElement {
    let _ = (id.into(), user, on_call);
    trigger.into_any_element()
}
