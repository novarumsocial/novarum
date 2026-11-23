// The websocket under realtime.rs, on the IO runtime. Eden's `anchor.client.realtime.subscribe()`.
use futures::{SinkExt, StreamExt, channel::mpsc};
use serde_json::Value;
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest, http::HeaderValue};

use crate::{api, realtime_events::RealtimeEvent, runtime};

pub enum SocketMessage {
    Open,
    Event(RealtimeEvent),
    Closed,
}

pub struct Socket {
    outgoing: mpsc::UnboundedSender<Value>,
}

impl Socket {
    pub fn send(&self, message: Value) {
        let _ = self.outgoing.unbounded_send(message);
    }
}

impl Drop for Socket {
    fn drop(&mut self) {
        self.outgoing.close_channel();
    }
}

pub fn open() -> (Socket, mpsc::UnboundedReceiver<SocketMessage>) {
    let (outgoing, mut outgoing_rx) = mpsc::unbounded::<Value>();
    let (incoming, incoming_rx) = mpsc::unbounded();
    let base = api::base_url();

    runtime::handle().spawn(async move {
        let closed = || {
            let _ = incoming.unbounded_send(SocketMessage::Closed);
        };
        let Ok(mut url) = url::Url::parse(&format!("{base}/realtime")) else { return closed() };
        let cookie = api::cookie_header(&url);
        let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
        let _ = url.set_scheme(scheme);
        let Ok(mut request) = url.as_str().into_client_request() else { return closed() };
        if let Some(cookie) = cookie.and_then(|cookie| HeaderValue::from_str(&cookie).ok()) {
            request.headers_mut().insert("cookie", cookie);
        }
        let Ok((stream, _)) = tokio_tungstenite::connect_async(request).await else { return closed() };
        let (mut write, mut read) = stream.split();
        let _ = incoming.unbounded_send(SocketMessage::Open);

        loop {
            tokio::select! {
                message = outgoing_rx.next() => match message {
                    Some(value) => {
                        if write.send(Message::Text(value.to_string().into())).await.is_err() { break }
                    }
                    None => {
                        let _ = write.close().await;
                        return;
                    }
                },
                message = read.next() => match message {
                    Some(Ok(Message::Text(text))) => {
                        if let Some(event) = crate::realtime_events::parse(&text) {
                            let _ = incoming.unbounded_send(SocketMessage::Event(event));
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = write.send(Message::Pong(payload)).await;
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => {}
                },
            }
        }
        closed();
    });

    (Socket { outgoing }, incoming_rx)
}
