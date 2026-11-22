// The web plays call video in <video> elements; here frames arrive on IO/capture threads and get
// turned into gpui images. Only the latest frame per feed is kept, and the UI is woken at most
// once per batch so a slow frame never queues up behind others.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use gpui_kit::*;
use livekit::webrtc::{
    prelude::{VideoBuffer, VideoFormatType},
    video_frame::native::VideoFrameBufferExt,
};
use tokio::sync::Notify;

/// A participant's camera or screen share.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct FeedKey {
    pub identity: String,
    pub screen: bool,
}

impl FeedKey {
    pub fn new(identity: &str, screen: bool) -> Self {
        Self {
            identity: identity.to_string(),
            screen,
        }
    }
}

type Pending = Arc<Mutex<HashMap<FeedKey, Option<Arc<RenderImage>>>>>;

/// Where capture and decode threads drop their frames; `None` ends a feed.
#[derive(Clone)]
pub struct FrameSink {
    pending: Pending,
    wake: Arc<Notify>,
}

impl FrameSink {
    pub fn push(&self, key: FeedKey, frame: Option<Arc<RenderImage>>) {
        self.pending.lock().unwrap().insert(key, frame);
        self.wake.notify_one();
    }

    pub fn push_buffer(&self, key: FeedKey, buffer: &dyn VideoBuffer) {
        if let Some(frame) = render_image(buffer) {
            self.push(key, Some(frame));
        }
    }
}

pub struct VideoFeeds {
    frames: HashMap<FeedKey, Arc<RenderImage>>,
    sink: FrameSink,
    _task: Task<()>,
}

struct GlobalVideoFeeds(Entity<VideoFeeds>);
impl Global for GlobalVideoFeeds {}

pub fn init(cx: &mut App) {
    let sink = FrameSink {
        pending: Arc::default(),
        wake: Arc::new(Notify::new()),
    };
    let feeds = cx.new(|cx| {
        let wake = sink.wake.clone();
        let pending = sink.pending.clone();
        let _task = cx.spawn(async move |this, cx| {
            loop {
                wake.notified().await;
                let batch = std::mem::take(&mut *pending.lock().unwrap());
                if this
                    .update(cx, |feeds: &mut VideoFeeds, cx| feeds.apply(batch, cx))
                    .is_err()
                {
                    break;
                }
            }
        });
        VideoFeeds {
            frames: HashMap::new(),
            sink: sink.clone(),
            _task,
        }
    });
    cx.set_global(GlobalVideoFeeds(feeds));
}

impl VideoFeeds {
    pub fn global(cx: &App) -> Entity<Self> {
        cx.global::<GlobalVideoFeeds>().0.clone()
    }

    pub fn sink(cx: &App) -> FrameSink {
        Self::global(cx).read(cx).sink.clone()
    }

    pub fn frame(&self, identity: &str, screen: bool) -> Option<Arc<RenderImage>> {
        self.frames.get(&FeedKey::new(identity, screen)).cloned()
    }

    fn apply(&mut self, batch: HashMap<FeedKey, Option<Arc<RenderImage>>>, cx: &mut Context<Self>) {
        for (key, frame) in batch {
            let old = match frame {
                Some(frame) => self.frames.insert(key, frame),
                None => self.frames.remove(&key),
            };
            // every frame is a new texture in the sprite atlas, so the last one has to go
            if let Some(old) = old {
                cx.drop_image(old, None);
            }
        }
        cx.notify();
    }
}

/// Converts any decoded or captured buffer into a BGRA gpui image (libyuv's "ARGB" is BGRA in
/// memory, which is what `RenderImage` wants).
fn render_image(buffer: &dyn VideoBuffer) -> Option<Arc<RenderImage>> {
    let (width, height) = (buffer.width(), buffer.height());
    if width == 0 || height == 0 {
        return None;
    }
    let mut data = vec![0u8; (width * height * 4) as usize];
    let args = (width * 4, width as i32, height as i32);
    macro_rules! convert {
        ($($as:ident),*) => {
            $(if let Some(buffer) = buffer.$as() {
                buffer.to_argb(VideoFormatType::ARGB, &mut data, args.0, args.1, args.2);
            } else)* {
                return None;
            }
        };
    }
    convert!(
        as_i420, as_native, as_nv12, as_i420a, as_i422, as_i444, as_i010
    );
    let image = image::RgbaImage::from_raw(width, height, data)?;
    Some(Arc::new(RenderImage::new([image::Frame::new(image)])))
}
