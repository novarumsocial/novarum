// In-app video playback (the web's <video> in video-player.svelte) through libmpv, loaded at
// runtime so Novarum still starts without it; the video player then opens videos externally.
// mpv decodes, plays the audio and keeps A/V in sync; its software renderer hands us frames that
// become gpui images, the same way call video does.
use std::{
    ffi::{CStr, CString, c_char, c_int, c_void},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::Duration,
};

use gpui_kit::{
    component::slider::{SliderEvent, SliderState},
    *,
};
use libloading::Library;
use tokio::sync::Notify;

use crate::models::Attachment;

const FORMAT_FLAG: c_int = 3;
const FORMAT_INT64: c_int = 4;
const FORMAT_DOUBLE: c_int = 5;
const EVENT_NONE: c_int = 0;
const EVENT_SHUTDOWN: c_int = 1;
const RENDER_PARAM_API_TYPE: c_int = 1;
const RENDER_PARAM_SW_SIZE: c_int = 17;
const RENDER_PARAM_SW_FORMAT: c_int = 18;
const RENDER_PARAM_SW_STRIDE: c_int = 19;
const RENDER_PARAM_SW_POINTER: c_int = 20;
const RENDER_UPDATE_FRAME: u64 = 1;
/// software rendering is all CPU, so frames are drawn at most this big
const MAX_FRAME: (i64, i64) = (1280, 720);

#[repr(C)]
struct Handle(c_void);
#[repr(C)]
struct RenderContext(c_void);

#[repr(C)]
struct Event {
    event_id: c_int,
    error: c_int,
    reply_userdata: u64,
    data: *mut c_void,
}

#[repr(C)]
struct RenderParam {
    kind: c_int,
    data: *mut c_void,
}

struct Mpv {
    _lib: Library,
    create: unsafe extern "C" fn() -> *mut Handle,
    initialize: unsafe extern "C" fn(*mut Handle) -> c_int,
    set_option_string: unsafe extern "C" fn(*mut Handle, *const c_char, *const c_char) -> c_int,
    command: unsafe extern "C" fn(*mut Handle, *mut *const c_char) -> c_int,
    get_property: unsafe extern "C" fn(*mut Handle, *const c_char, c_int, *mut c_void) -> c_int,
    set_property: unsafe extern "C" fn(*mut Handle, *const c_char, c_int, *mut c_void) -> c_int,
    wait_event: unsafe extern "C" fn(*mut Handle, f64) -> *mut Event,
    terminate_destroy: unsafe extern "C" fn(*mut Handle),
    render_create:
        unsafe extern "C" fn(*mut *mut RenderContext, *mut Handle, *mut RenderParam) -> c_int,
    render_set_update_callback: unsafe extern "C" fn(
        *mut RenderContext,
        Option<unsafe extern "C" fn(*mut c_void)>,
        *mut c_void,
    ),
    render_update: unsafe extern "C" fn(*mut RenderContext) -> u64,
    render: unsafe extern "C" fn(*mut RenderContext, *mut RenderParam) -> c_int,
    render_free: unsafe extern "C" fn(*mut RenderContext),
}

fn library_candidates() -> Vec<std::path::PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["libmpv-2.dll", "mpv-2.dll"]
    } else if cfg!(target_os = "macos") {
        &["libmpv.2.dylib", "libmpv.dylib"]
    } else {
        &["libmpv.so.2", "libmpv.so"]
    };
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.to_path_buf()));
    let mut dirs: Vec<std::path::PathBuf> = exe_dir.iter().cloned().collect();
    // inside the AppImage, linuxdeploy keeps bundled libraries under usr/lib
    if let Some(appdir) = std::env::var_os("APPDIR").map(std::path::PathBuf::from) {
        dirs.extend([
            appdir.join("usr/lib"),
            appdir.join("usr/lib/x86_64-linux-gnu"),
        ]);
    }
    if cfg!(target_os = "macos") {
        if let Some(dir) = &exe_dir {
            dirs.push(dir.join("../Frameworks"));
        }
        dirs.extend(["/opt/homebrew/lib", "/usr/local/lib"].map(Into::into));
    }
    let mut candidates: Vec<_> = dirs
        .iter()
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .collect();
    // the system's own search path last
    candidates.extend(names.iter().map(Into::into));
    candidates
}

fn mpv() -> Option<&'static Mpv> {
    static MPV: OnceLock<Option<Mpv>> = OnceLock::new();
    MPV.get_or_init(|| {
        let lib = library_candidates()
            .into_iter()
            .find_map(|path| unsafe { Library::new(path) }.ok())?;
        unsafe {
            macro_rules! sym {
                ($name:literal) => {
                    *lib.get(concat!($name, "\0").as_bytes()).ok()?
                };
            }
            Some(Mpv {
                create: sym!("mpv_create"),
                initialize: sym!("mpv_initialize"),
                set_option_string: sym!("mpv_set_option_string"),
                command: sym!("mpv_command"),
                get_property: sym!("mpv_get_property"),
                set_property: sym!("mpv_set_property"),
                wait_event: sym!("mpv_wait_event"),
                terminate_destroy: sym!("mpv_terminate_destroy"),
                render_create: sym!("mpv_render_context_create"),
                render_set_update_callback: sym!("mpv_render_context_set_update_callback"),
                render_update: sym!("mpv_render_context_update"),
                render: sym!("mpv_render_context_render"),
                render_free: sym!("mpv_render_context_free"),
                _lib: lib,
            })
        }
    })
    .as_ref()
}

/// Whether libmpv could be loaded, so videos can play inside Novarum.
pub fn available() -> bool {
    mpv().is_some()
}

/// The mpv client API is thread-safe, so the handle is shared with the render thread.
struct SharedHandle(*mut Handle);
unsafe impl Send for SharedHandle {}
unsafe impl Sync for SharedHandle {}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct PlaybackState {
    pub position: f64,
    pub duration: f64,
    pub paused: bool,
    pub muted: bool,
    pub ended: bool,
    /// waiting on the network, or still opening the file
    pub buffering: bool,
}

struct Shared {
    state: PlaybackState,
    frame: Option<Arc<RenderImage>>,
}

/// One playing video: mpv plus the thread that renders its frames and reads its state.
struct Player {
    mpv: &'static Mpv,
    handle: Arc<SharedHandle>,
    stop: Arc<AtomicBool>,
    wake: mpsc::Sender<()>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Player {
    fn open(url: &str, shared: Arc<Mutex<Shared>>, notify: Arc<Notify>) -> Result<Self, String> {
        let mpv = mpv().ok_or("libmpv isn't installed")?;
        let handle = unsafe { (mpv.create)() };
        if handle.is_null() {
            return Err("mpv_create failed".into());
        }
        let set = |name: &str, value: &str| {
            let (name, value) = (CString::new(name).unwrap(), CString::new(value).unwrap());
            unsafe { (mpv.set_option_string)(handle, name.as_ptr(), value.as_ptr()) };
        };
        set("vo", "libmpv");
        set("hwdec", "auto-copy-safe");
        set("keep-open", "yes");
        set("terminal", "no");
        set("input-default-bindings", "no");
        set("ytdl", "no");
        set("audio-client-name", "Novarum");
        if unsafe { (mpv.initialize)(handle) } < 0 {
            unsafe { (mpv.terminate_destroy)(handle) };
            return Err("mpv_initialize failed".into());
        }

        let mut context: *mut RenderContext = std::ptr::null_mut();
        let mut params = [
            RenderParam {
                kind: RENDER_PARAM_API_TYPE,
                data: c"sw".as_ptr() as *mut c_void,
            },
            RenderParam {
                kind: 0,
                data: std::ptr::null_mut(),
            },
        ];
        if unsafe { (mpv.render_create)(&mut context, handle, params.as_mut_ptr()) } < 0 {
            unsafe { (mpv.terminate_destroy)(handle) };
            return Err("This libmpv has no software renderer".into());
        }

        let (wake, woken) = mpsc::channel::<()>();
        // the update callback only nudges the render thread; mpv forbids calling it from there
        let callback_wake = Box::into_raw(Box::new(wake.clone())) as usize;
        unsafe extern "C" fn on_update(wake: *mut c_void) {
            let _ = unsafe { &*(wake as *const mpsc::Sender<()>) }.send(());
        }
        unsafe {
            (mpv.render_set_update_callback)(context, Some(on_update), callback_wake as *mut c_void)
        };

        let handle = Arc::new(SharedHandle(handle));
        let stop = Arc::new(AtomicBool::new(false));
        let thread = {
            let (handle, stop) = (handle.clone(), stop.clone());
            let context = SharedContext(context);
            std::thread::spawn(move || {
                let context = context;
                render_loop(mpv, &handle, context.0, &stop, woken, &shared, &notify);
                unsafe {
                    (mpv.render_free)(context.0);
                    (mpv.terminate_destroy)(handle.0);
                    drop(Box::from_raw(callback_wake as *mut mpsc::Sender<()>));
                }
            })
        };

        let player = Self {
            mpv,
            handle,
            stop,
            wake,
            thread: Some(thread),
        };
        player.command(&["loadfile", url]);
        Ok(player)
    }

    fn command(&self, args: &[&str]) {
        let args: Vec<CString> = args.iter().map(|arg| CString::new(*arg).unwrap()).collect();
        let mut pointers: Vec<*const c_char> = args.iter().map(|arg| arg.as_ptr()).collect();
        pointers.push(std::ptr::null());
        unsafe { (self.mpv.command)(self.handle.0, pointers.as_mut_ptr()) };
        let _ = self.wake.send(());
    }

    fn set_double(&self, name: &CStr, mut value: f64) {
        unsafe {
            (self.mpv.set_property)(
                self.handle.0,
                name.as_ptr(),
                FORMAT_DOUBLE,
                &mut value as *mut f64 as *mut c_void,
            )
        };
        let _ = self.wake.send(());
    }

    fn set_flag(&self, name: &CStr, value: bool) {
        let mut value = value as c_int;
        unsafe {
            (self.mpv.set_property)(
                self.handle.0,
                name.as_ptr(),
                FORMAT_FLAG,
                &mut value as *mut c_int as *mut c_void,
            )
        };
        let _ = self.wake.send(());
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.wake.send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

struct SharedContext(*mut RenderContext);
unsafe impl Send for SharedContext {}

fn get_double(mpv: &Mpv, handle: *mut Handle, name: &CStr) -> Option<f64> {
    let mut value = 0f64;
    let ok = unsafe {
        (mpv.get_property)(
            handle,
            name.as_ptr(),
            FORMAT_DOUBLE,
            &mut value as *mut f64 as *mut c_void,
        )
    } >= 0;
    ok.then_some(value)
}

fn get_flag(mpv: &Mpv, handle: *mut Handle, name: &CStr) -> bool {
    let mut value: c_int = 0;
    unsafe {
        (mpv.get_property)(
            handle,
            name.as_ptr(),
            FORMAT_FLAG,
            &mut value as *mut c_int as *mut c_void,
        )
    };
    value != 0
}

fn get_int(mpv: &Mpv, handle: *mut Handle, name: &CStr) -> i64 {
    let mut value = 0i64;
    unsafe {
        (mpv.get_property)(
            handle,
            name.as_ptr(),
            FORMAT_INT64,
            &mut value as *mut i64 as *mut c_void,
        )
    };
    value
}

fn render_loop(
    mpv: &Mpv,
    handle: &SharedHandle,
    context: *mut RenderContext,
    stop: &AtomicBool,
    woken: mpsc::Receiver<()>,
    shared: &Mutex<Shared>,
    notify: &Notify,
) {
    let mut buffer: Vec<u32> = Vec::new();
    while !stop.load(Ordering::Relaxed) {
        // frames wake us; the timeout keeps the clock moving while paused or buffering
        let _ = woken.recv_timeout(Duration::from_millis(250));
        loop {
            let event = unsafe { &*(mpv.wait_event)(handle.0, 0.0) };
            match event.event_id {
                EVENT_NONE => break,
                EVENT_SHUTDOWN => return,
                _ => {}
            }
        }

        let frame = if unsafe { (mpv.render_update)(context) } & RENDER_UPDATE_FRAME != 0 {
            render_frame(mpv, handle.0, context, &mut buffer)
        } else {
            None
        };
        let state = PlaybackState {
            position: get_double(mpv, handle.0, c"time-pos").unwrap_or(0.0),
            duration: get_double(mpv, handle.0, c"duration").unwrap_or(0.0),
            paused: get_flag(mpv, handle.0, c"pause"),
            muted: get_flag(mpv, handle.0, c"mute"),
            ended: get_flag(mpv, handle.0, c"eof-reached"),
            buffering: get_flag(mpv, handle.0, c"paused-for-cache")
                || get_flag(mpv, handle.0, c"idle-active"),
        };
        let mut shared = shared.lock().unwrap();
        if frame.is_none() && shared.state == state {
            continue;
        }
        shared.state = state;
        if frame.is_some() {
            shared.frame = frame;
        }
        drop(shared);
        notify.notify_one();
    }
}

/// Draws the current frame at its display size (capped), as an opaque BGRA image.
fn render_frame(
    mpv: &Mpv,
    handle: *mut Handle,
    context: *mut RenderContext,
    buffer: &mut Vec<u32>,
) -> Option<Arc<RenderImage>> {
    let (width, height) = (
        get_int(mpv, handle, c"dwidth"),
        get_int(mpv, handle, c"dheight"),
    );
    if width <= 0 || height <= 0 {
        return None;
    }
    let scale = (MAX_FRAME.0 as f64 / width as f64)
        .min(MAX_FRAME.1 as f64 / height as f64)
        .min(1.0);
    let (width, height) = (
        ((width as f64 * scale) as usize).max(2),
        ((height as f64 * scale) as usize).max(2),
    );
    // stride a multiple of 64 bytes, as the software renderer prefers
    let stride_pixels = width.div_ceil(16) * 16;
    buffer.resize(stride_pixels * height, 0);
    let mut size = [width as c_int, height as c_int];
    let mut stride = stride_pixels * 4;
    let mut params = [
        RenderParam {
            kind: RENDER_PARAM_SW_SIZE,
            data: size.as_mut_ptr() as *mut c_void,
        },
        RenderParam {
            kind: RENDER_PARAM_SW_FORMAT,
            data: c"bgr0".as_ptr() as *mut c_void,
        },
        RenderParam {
            kind: RENDER_PARAM_SW_STRIDE,
            data: &mut stride as *mut usize as *mut c_void,
        },
        RenderParam {
            kind: RENDER_PARAM_SW_POINTER,
            data: buffer.as_mut_ptr() as *mut c_void,
        },
        RenderParam {
            kind: 0,
            data: std::ptr::null_mut(),
        },
    ];
    if unsafe { (mpv.render)(context, params.as_mut_ptr()) } < 0 {
        return None;
    }
    let mut pixels = Vec::with_capacity(width * height * 4);
    for row in buffer.chunks_exact(stride_pixels) {
        for pixel in &row[..width] {
            // the "0" byte is garbage; gpui wants it opaque
            let [b, g, r, _] = pixel.to_le_bytes();
            pixels.extend_from_slice(&[b, g, r, 255]);
        }
    }
    let image = image::RgbaImage::from_raw(width as u32, height as u32, pixels)?;
    Some(Arc::new(RenderImage::new([image::Frame::new(image)])))
}

/// The video playing inline (one at a time, like starting a new one pauses the last on the web).
pub struct Media {
    active: Option<Active>,
    /// the seek bar's drag, which spans frames
    pub seeking: std::rc::Rc<std::cell::Cell<bool>>,
    /// 0-100, kept across videos like a browser tab's
    pub volume_slider: Entity<SliderState>,
    volume: f64,
    /// the playing video fills the window
    fullscreen: bool,
    _volume: Subscription,
}

struct Active {
    attachment: Attachment,
    player: Player,
    frame: Option<Arc<RenderImage>>,
    state: PlaybackState,
    _task: Task<()>,
}

struct GlobalMedia(Entity<Media>);
impl Global for GlobalMedia {}

pub fn init(cx: &mut App) {
    let media = cx.new(|cx| {
        let volume_slider = cx.new(|_| {
            SliderState::new()
                .min(0.0)
                .max(100.0)
                .step(1.0)
                .default_value(100.0)
        });
        let _volume = cx.subscribe(&volume_slider, |media: &mut Media, _, event, cx| {
            let (SliderEvent::Change(value) | SliderEvent::Release(value)) = event;
            media.set_volume(value.start() as f64, cx);
        });
        Media {
            active: None,
            seeking: Default::default(),
            volume_slider,
            volume: 100.0,
            fullscreen: false,
            _volume,
        }
    });
    cx.set_global(GlobalMedia(media));
}

impl Media {
    pub fn global(cx: &App) -> Entity<Self> {
        cx.global::<GlobalMedia>().0.clone()
    }

    /// The frame and state of `key`'s video, if it's the one playing.
    pub fn playing(&self, key: &str) -> Option<(Option<Arc<RenderImage>>, PlaybackState)> {
        self.active
            .as_ref()
            .filter(|active| active.attachment.id == key)
            .map(|active| (active.frame.clone(), active.state.clone()))
    }

    pub fn play(&mut self, attachment: &Attachment, cx: &mut Context<Self>) -> Result<(), String> {
        self.stop(cx);
        let shared = Arc::new(Mutex::new(Shared {
            state: PlaybackState {
                buffering: true,
                ..Default::default()
            },
            frame: None,
        }));
        let notify = Arc::new(Notify::new());
        let player = Player::open(&attachment.url, shared.clone(), notify.clone())?;
        player.set_double(c"volume", self.volume);
        let task = cx.spawn({
            async move |this, cx| {
                loop {
                    notify.notified().await;
                    let (state, frame) = {
                        let mut shared = shared.lock().unwrap();
                        (shared.state.clone(), shared.frame.take())
                    };
                    let updated = this.update(cx, |media, cx| {
                        let Some(active) = &mut media.active else {
                            return;
                        };
                        active.state = state;
                        if let Some(frame) = frame
                            && let Some(old) = active.frame.replace(frame)
                        {
                            // each frame is its own texture in the sprite atlas
                            cx.drop_image(old, None);
                        }
                        cx.notify();
                    });
                    if updated.is_err() {
                        break;
                    }
                }
            }
        });
        self.active = Some(Active {
            attachment: attachment.clone(),
            player,
            frame: None,
            state: PlaybackState {
                buffering: true,
                ..Default::default()
            },
            _task: task,
        });
        cx.notify();
        Ok(())
    }

    pub fn set_volume(&mut self, volume: f64, cx: &mut Context<Self>) {
        self.volume = volume.clamp(0.0, 100.0);
        if let Some(active) = &self.active {
            active.player.set_double(c"volume", self.volume);
            if active.state.muted && self.volume > 0.0 {
                active.player.set_flag(c"mute", false);
            }
        }
        cx.notify();
    }

    /// The video filling the window, if any (it's drawn over the app by `AppRoot`).
    pub fn fullscreen(&self) -> Option<&Attachment> {
        self.active
            .as_ref()
            .filter(|_| self.fullscreen)
            .map(|active| &active.attachment)
    }

    pub fn set_fullscreen(&mut self, on: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.fullscreen = on && self.active.is_some();
        if window.is_fullscreen() != self.fullscreen {
            window.toggle_fullscreen();
        }
        cx.notify();
    }

    pub fn stop(&mut self, cx: &mut Context<Self>) {
        self.fullscreen = false;
        if let Some(active) = self.active.take() {
            drop(active.player);
            if let Some(frame) = active.frame {
                cx.drop_image(frame, None);
            }
            cx.notify();
        }
    }

    pub fn toggle_pause(&mut self) {
        if let Some(active) = &self.active {
            if active.state.ended {
                active.player.command(&["seek", "0", "absolute"]);
                active.player.set_flag(c"pause", false);
            } else {
                active.player.set_flag(c"pause", !active.state.paused);
            }
        }
    }

    pub fn toggle_mute(&mut self) {
        if let Some(active) = &self.active {
            active.player.set_flag(c"mute", !active.state.muted);
        }
    }

    /// `fraction` of the way through the video.
    pub fn seek(&mut self, fraction: f32) {
        if let Some(active) = &self.active {
            let percent = (fraction.clamp(0.0, 1.0) * 100.0).to_string();
            active
                .player
                .command(&["seek", &percent, "absolute-percent+exact"]);
        }
    }
}
