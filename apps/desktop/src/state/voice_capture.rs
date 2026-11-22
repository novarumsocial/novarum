// The web's `setCameraEnabled`/`setScreenShareEnabled` capture: here the camera comes from nokhwa
// and the screen from libwebrtc's desktop capturer (the portal picker on Wayland, the system
// picker on macOS). Each runs on its own thread, feeding a LiveKit video source and the local
// preview, until the returned `Capture` is dropped.
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use livekit::{
    prelude::*,
    webrtc::{
        native::yuv_helper,
        prelude::{I420Buffer, RtcVideoSource, VideoFrame, VideoResolution, VideoRotation},
        video_source::native::NativeVideoSource,
    },
};
use tokio::sync::oneshot;

use crate::state::video::{FeedKey, FrameSink};

const SCREEN_FPS: u64 = 30;

pub struct Capture {
    pub track: LocalVideoTrack,
    stop: Arc<AtomicBool>,
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// Packs a BGRA ("ARGB" to libyuv) or RGBA ("ABGR") frame into I420, sends it and previews it.
struct Feeder {
    source: NativeVideoSource,
    preview: FrameSink,
    key: FeedKey,
}

impl Feeder {
    fn feed(&self, pixels: &[u8], stride: u32, width: u32, height: u32, bgra: bool) {
        let mut buffer = I420Buffer::new(width, height);
        let (stride_y, stride_u, stride_v) = buffer.strides();
        let (y, u, v) = buffer.data_mut();
        let convert = if bgra {
            yuv_helper::argb_to_i420
        } else {
            yuv_helper::abgr_to_i420
        };
        convert(
            pixels,
            stride,
            y,
            stride_y,
            u,
            stride_u,
            v,
            stride_v,
            width as i32,
            height as i32,
        );
        let timestamp_us = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |time| time.as_micros() as i64);
        let frame = VideoFrame {
            rotation: VideoRotation::VideoRotation0,
            timestamp_us,
            frame_metadata: None,
            buffer,
        };
        self.source.capture_frame(&frame);
        self.preview.push_buffer(self.key.clone(), &frame.buffer);
    }
}

fn start(
    name: &str,
    resolution: VideoResolution,
    screencast: bool,
    preview: FrameSink,
    key: FeedKey,
) -> (Feeder, Capture, Arc<AtomicBool>) {
    let source = NativeVideoSource::new(resolution, screencast);
    let track = LocalVideoTrack::create_video_track(name, RtcVideoSource::Native(source.clone()));
    let stop = Arc::new(AtomicBool::new(false));
    let feeder = Feeder {
        source,
        preview,
        key,
    };
    (
        feeder,
        Capture {
            track,
            stop: stop.clone(),
        },
        stop,
    )
}

/// `device` is the camera's human name from settings; anything else falls back to the first one.
pub async fn camera(device: String, preview: FrameSink, key: FeedKey) -> Result<Capture, String> {
    use nokhwa::{
        Camera,
        pixel_format::RgbAFormat,
        utils::{ApiBackend, CameraFormat, FrameFormat, RequestedFormat, RequestedFormatType},
    };

    let (feeder, capture, stop) = start(
        "camera",
        VideoResolution::default(),
        false,
        preview.clone(),
        key.clone(),
    );
    let (ready, opened) = oneshot::channel();
    std::thread::spawn(move || {
        let open = || -> Result<Camera, String> {
            // one webcam can show up as several devices (metadata and IR nodes that can't
            // stream), in no particular order, so try the chosen one first and then by index
            let mut cameras = nokhwa::query(ApiBackend::Auto).map_err(|error| error.to_string())?;
            cameras.sort_by_key(|camera| {
                (
                    camera.human_name() != device,
                    camera.index().as_index().unwrap_or(u32::MAX),
                )
            });
            let mut last_error = "No camera found".to_string();
            for info in &cameras {
                for requested in [
                    RequestedFormatType::Closest(CameraFormat::new_from(
                        1280,
                        720,
                        FrameFormat::MJPEG,
                        30,
                    )),
                    RequestedFormatType::None,
                ] {
                    let format = RequestedFormat::new::<RgbAFormat>(requested);
                    let opened = Camera::new(info.index().clone(), format)
                        .and_then(|mut camera| camera.open_stream().map(|_| camera));
                    match opened {
                        Ok(camera) => return Ok(camera),
                        Err(error) => last_error = error.to_string(),
                    }
                }
            }
            Err(last_error)
        };
        let mut camera = match open() {
            Ok(camera) => camera,
            Err(error) => {
                let _ = ready.send(Err(error));
                return;
            }
        };
        let _ = ready.send(Ok(()));
        while !stop.load(Ordering::Relaxed) {
            let Ok(image) = camera
                .frame()
                .and_then(|frame| frame.decode_image::<RgbAFormat>())
            else {
                std::thread::sleep(Duration::from_millis(30));
                continue;
            };
            let (width, height) = (image.width(), image.height());
            feeder.feed(image.as_raw(), width * 4, width, height, false);
        }
        let _ = camera.stop_stream();
        preview.push(key, None);
    });
    opened
        .await
        .map_err(|_| "Camera thread died".to_string())??;
    Ok(capture)
}

/// Resolves once the first frame arrives, or fails if the picker was cancelled. `on_end` runs
/// if the share stops by itself (the compositor or the system picker ended it).
pub async fn screen(
    preview: FrameSink,
    key: FeedKey,
    on_end: impl FnOnce() + Send + 'static,
) -> Result<Capture, String> {
    use livekit::webrtc::desktop_capturer::{
        CaptureError, DesktopCaptureSourceType, DesktopCapturer, DesktopCapturerOptions,
    };

    let (feeder, capture, stop) = start(
        "screen",
        VideoResolution {
            width: 1920,
            height: 1080,
        },
        true,
        preview.clone(),
        key.clone(),
    );
    let (ready, started) = oneshot::channel::<Result<(), String>>();
    std::thread::spawn(move || {
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        let kind = DesktopCaptureSourceType::Generic;
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        let kind = DesktopCaptureSourceType::Screen;
        let mut options = DesktopCapturerOptions::new(kind);
        options.set_include_cursor(true);
        let Some(mut capturer) = DesktopCapturer::new(options) else {
            let _ = ready.send(Err("Screen capture isn't available".into()));
            return;
        };
        let source = if cfg!(target_os = "windows") {
            capturer.get_source_list().into_iter().next()
        } else {
            None
        };

        let ready = Arc::new(std::sync::Mutex::new(Some(ready)));
        let failed = Arc::new(AtomicBool::new(false));
        let streaming = Arc::new(AtomicBool::new(false));
        capturer.start_capture(source, {
            let (ready, failed, streaming) = (ready.clone(), failed.clone(), streaming.clone());
            move |result| {
                let report = |result| {
                    if let Some(ready) = ready.lock().unwrap().take() {
                        let _ = ready.send(result);
                    }
                };
                match result {
                    Ok(frame) => {
                        report(Ok(()));
                        streaming.store(true, Ordering::Relaxed);
                        feeder.feed(
                            frame.data(),
                            frame.stride(),
                            frame.width() as u32,
                            frame.height() as u32,
                            true,
                        );
                    }
                    Err(CaptureError::Permanent) => {
                        report(Err("Screen share was cancelled".into()));
                        failed.store(true, Ordering::Relaxed);
                    }
                    Err(CaptureError::Temporary) => {}
                }
            }
        });
        while !stop.load(Ordering::Relaxed) && !failed.load(Ordering::Relaxed) {
            capturer.capture_frame();
            std::thread::sleep(Duration::from_millis(1000 / SCREEN_FPS));
        }
        drop(capturer);
        preview.push(key, None);
        if streaming.load(Ordering::Relaxed) && !stop.load(Ordering::Relaxed) {
            on_end();
        }
    });
    started
        .await
        .map_err(|_| "Screen capture thread died".to_string())??;
    Ok(capture)
}
