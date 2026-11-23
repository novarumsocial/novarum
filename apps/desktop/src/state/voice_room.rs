// The LiveKit side of `Voice` (apps/frontend/src/lib/voice.svelte.ts's `Room` and its event
// handlers). Lives on the tokio IO runtime because the SDK needs one; the UI-facing `state::voice`
// entity talks to it through `VoiceCommand`s in and `VoiceRoomEvent`s out.
use std::collections::{HashMap, HashSet};

use livekit::{prelude::*, webrtc::video_stream::native::NativeVideoStream};

use futures::{StreamExt, channel::mpsc};
use serde::Deserialize;

use crate::{
    api, runtime,
    state::{
        audio_engine::AudioEngine,
        video::{FeedKey, FrameSink},
        voice::ConnectionState as UiState,
        voice_capture::{self, Capture},
    },
};

const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

pub use crate::state::audio_engine::{NoiseModel, Processing as AudioProcessing};

#[derive(Debug, Clone)]
pub struct AudioDevices {
    pub input: String,
    pub output: String,
}

pub struct JoinOptions {
    pub processing: AudioProcessing,
    pub devices: AudioDevices,
    pub muted: bool,
    pub deafened: bool,
    /// identity -> (volume, muted, screen volume), the web's `participantAudio`
    pub participant_audio: HashMap<String, ParticipantAudio>,
}

#[derive(Debug, Clone, Copy)]
pub struct ParticipantAudio {
    pub volume: f32,
    pub muted: bool,
    pub screen_volume: f32,
}

#[derive(Debug, Clone)]
pub struct ParticipantHandle {
    pub username: String,
    pub homeserver: String,
}

/// `VoiceState`, keyed by participant identity.
pub type VoiceStates = HashMap<String, crate::state::voice::VoiceState>;

pub struct Snapshot {
    pub connection_state: UiState,
    pub local_identity: Option<String>,
    pub states: VoiceStates,
    pub handles: HashMap<String, ParticipantHandle>,
}

pub enum VoiceCommand {
    Join {
        channel_id: String,
        options: JoinOptions,
    },
    Leave,
    SetMuted {
        muted: bool,
    },
    SetDeafened {
        deafened: bool,
    },
    SetProcessing {
        processing: AudioProcessing,
    },
    SetDevices {
        devices: AudioDevices,
    },
    SetParticipantAudio {
        identity: String,
        audio: ParticipantAudio,
    },
    /// The web's `watchStream`/`stopWatchingStream`.
    WatchStream {
        identity: String,
        watching: bool,
    },
    /// `device` is the camera's name from settings.
    SetCamera {
        on: bool,
        device: String,
    },
    /// `system_audio` also shares what the computer plays.
    SetScreenShare {
        on: bool,
        system_audio: bool,
    },
    /// A capture started in the background (a picker can stay open for a while) has finished
    /// starting; sent by the room itself.
    Captured {
        screen: bool,
        result: Result<Capture, String>,
    },
}

pub enum VoiceRoomEvent {
    Sync(Snapshot),
    /// Remote call sounds: someone joined, muted their mic or started sharing.
    ParticipantJoined,
    ParticipantLeft(String),
    MicChanged {
        identity: String,
        muted: bool,
    },
    ScreenChanged {
        identity: String,
        on: bool,
    },
    CameraChanged {
        identity: String,
        on: bool,
    },
    /// The camera or screen couldn't start (no device, picker cancelled, publish failed).
    CaptureFailed,
    /// The room went away on its own (network died, kicked); the UI cleans up and re-syncs presence.
    Left,
}

#[derive(Deserialize)]
struct CallToken {
    #[serde(rename = "serverUrl")]
    server_url: String,
    token: String,
}

/// Like the web: everything is subscribed except screen shares nobody chose to watch.
fn subscribable(source: TrackSource, watched: bool) -> bool {
    match source {
        TrackSource::Screenshare | TrackSource::ScreenshareAudio => watched,
        _ => true,
    }
}

fn parse_handle(metadata: &str) -> Option<ParticipantHandle> {
    #[derive(Deserialize)]
    struct Handle {
        username: String,
        homeserver: String,
    }
    // the server bakes channelId/guildId/userId in there too; only the handle matters here
    let value: serde_json::Value = serde_json::from_str(metadata).ok()?;
    let handle: Handle = serde_json::from_value(value).ok()?;
    Some(ParticipantHandle {
        username: handle.username,
        homeserver: handle.homeserver,
    })
}

struct Session {
    room: Room,
    events: tokio::sync::mpsc::UnboundedReceiver<RoomEvent>,
}

/// A local camera or screen share, published into the room.
struct Published {
    _capture: Capture,
    sid: TrackSid,
}

/// The decode loop of a subscribed remote video track.
struct RemoteVideo {
    key: FeedKey,
    task: tokio::task::JoinHandle<()>,
}

/// The voice state the room side needs: flags the UI entity is the source of truth for.
struct Actor {
    events: mpsc::UnboundedSender<VoiceRoomEvent>,
    channel_id: String,
    audio: Option<AudioEngine>,
    mic: Option<LocalAudioTrack>,
    muted: bool,
    deafened: bool,
    processing: AudioProcessing,
    devices: AudioDevices,
    participant_audio: HashMap<String, ParticipantAudio>,
    watched: HashSet<String>,
    /// tells join attempts apart, like the web's `connectionAttempt`
    attempt: u64,
    frames: FrameSink,
    commands: mpsc::UnboundedSender<VoiceCommand>,
    camera: Option<Published>,
    screen: Option<Published>,
    /// what the user last asked for, so a capture that finishes starting late can be dropped
    want_camera: bool,
    want_screen: bool,
    system_audio: bool,
    screen_audio: Option<(crate::state::screen_audio::ScreenAudio, TrackSid)>,
    remote_video: HashMap<TrackSid, RemoteVideo>,
}

impl Actor {
    fn send(&self, event: VoiceRoomEvent) {
        let _ = self.events.unbounded_send(event);
    }

    fn apply_join(&mut self, channel_id: String, options: JoinOptions) {
        self.channel_id = channel_id;
        self.attempt += 1;
        self.muted = options.muted;
        self.deafened = options.deafened;
        self.processing = options.processing;
        self.devices = options.devices;
        self.participant_audio = options.participant_audio;
        self.watched.clear();
        self.want_camera = false;
        self.want_screen = false;
    }

    fn send_sync(&self, session: &Session, state: UiState) {
        self.send(VoiceRoomEvent::Sync(self.snapshot(session, state)));
    }

    async fn publish_mic(&mut self, room: &Room) -> Option<LocalAudioTrack> {
        let source = self.audio.as_ref()?.source();
        let track = LocalAudioTrack::create_audio_track(
            "microphone",
            livekit::webrtc::audio_source::RtcAudioSource::Native(source),
        );
        let publication = room
            .local_participant()
            .publish_track(
                LocalTrack::Audio(track.clone()),
                TrackPublishOptions {
                    source: TrackSource::Microphone,
                    ..TrackPublishOptions::default()
                },
            )
            .await;
        match publication {
            Ok(_) => {
                if self.muted || self.deafened {
                    track.mute();
                }
                Some(track)
            }
            Err(error) => {
                eprintln!("Could not publish the microphone: {error}");
                self.muted = true;
                None
            }
        }
    }

    /// The volume `identity`'s track from `source` plays at: their mic or their stream's.
    fn gain(&self, identity: &str, source: TrackSource) -> f32 {
        let settings = self.participant_audio.get(identity);
        if settings.is_some_and(|audio| audio.muted) {
            return 0.0;
        }
        match source {
            TrackSource::ScreenshareAudio => settings.map(|audio| audio.screen_volume),
            _ => settings.map(|audio| audio.volume),
        }
        .unwrap_or(1.0)
    }

    async fn dial(&mut self) -> Result<Session, ()> {
        self.send(VoiceRoomEvent::Sync(Snapshot {
            connection_state: UiState::Connecting,
            local_identity: None,
            states: HashMap::new(),
            handles: HashMap::new(),
        }));

        let token = match api::get::<CallToken>(&format!("/channel/{}/call/token", self.channel_id))
            .await
        {
            Ok(token) => token,
            Err(error) => {
                eprintln!("Could not get a voice token: {error}");
                return Err(());
            }
        };

        let connect = Room::connect(&token.server_url, &token.token, {
            let mut options = RoomOptions::default();
            options.auto_subscribe = false;
            options
        });
        let attempt = self.attempt;
        let Ok(connect) = tokio::time::timeout(CONNECT_TIMEOUT, connect).await else {
            eprintln!("Voice connection timed out");
            return Err(());
        };
        let (room, events) = match connect {
            Ok(room) => room,
            Err(error) => {
                eprintln!("Could not join the voice room: {error}");
                return Err(());
            }
        };
        // a Leave or another Join raced past the handshake
        if attempt != self.attempt {
            let _ = room.close().await;
            return Err(());
        }

        let audio = AudioEngine::new(
            &self.devices.input,
            &self.devices.output,
            self.processing.clone(),
        );
        audio.set_muted(self.muted || self.deafened);
        audio.set_deafened(self.deafened);
        self.audio = Some(audio);

        self.mic = self.publish_mic(&room).await;
        // with auto-subscribe off, whoever was already here needs subscribing by hand
        for participant in room.remote_participants().values() {
            self.sync_subscriptions(participant).await;
        }
        Ok(Session { room, events })
    }

    async fn on_command(&mut self, session: &Session, command: VoiceCommand) {
        match command {
            VoiceCommand::Join { .. } | VoiceCommand::Leave => {
                unreachable!("handled by the runner")
            }
            VoiceCommand::SetMuted { muted } => {
                self.muted = muted;
                if let Some(mic) = &self.mic {
                    if muted { mic.mute() } else { mic.unmute() }
                }
                if let Some(audio) = &self.audio {
                    audio.set_muted(muted || self.deafened);
                }
                self.send_sync(session, UiState::Connected);
            }
            VoiceCommand::SetDeafened { deafened } => {
                self.deafened = deafened;
                if let Some(audio) = &self.audio {
                    audio.set_deafened(deafened);
                    audio.set_muted(self.muted || deafened);
                }
                self.send_sync(session, UiState::Connected);
            }
            VoiceCommand::SetProcessing { processing } => {
                if let Some(audio) = &self.audio {
                    audio.set_processing(processing.clone());
                }
                self.processing = processing;
            }
            VoiceCommand::SetDevices { devices } => {
                if let Some(audio) = &mut self.audio {
                    audio.set_devices(&devices.input, &devices.output);
                }
                self.devices = devices;
            }
            VoiceCommand::SetParticipantAudio { identity, audio } => {
                self.participant_audio.insert(identity, audio);
                self.apply_remote_audio(session);
            }
            VoiceCommand::WatchStream { identity, watching } => {
                if watching {
                    self.watched.insert(identity.clone());
                } else {
                    self.watched.remove(&identity);
                }
                if let Some(participant) = session
                    .room
                    .remote_participants()
                    .values()
                    .find(|participant| participant.identity().as_str() == identity)
                    .cloned()
                {
                    self.sync_subscriptions(&participant).await;
                }
            }
            VoiceCommand::SetCamera { on, device } => {
                self.want_camera = on;
                if !on {
                    self.unpublish(session, false).await;
                } else if self.camera.is_none() {
                    let key =
                        FeedKey::new(session.room.local_participant().identity().as_str(), false);
                    let (frames, commands) = (self.frames.clone(), self.commands.clone());
                    tokio::spawn(async move {
                        let result = voice_capture::camera(device, frames, key).await;
                        let _ = commands.unbounded_send(VoiceCommand::Captured {
                            screen: false,
                            result,
                        });
                    });
                }
                self.send_sync(session, UiState::Connected);
            }
            VoiceCommand::SetScreenShare { on, system_audio } => {
                self.want_screen = on;
                self.system_audio = system_audio;
                if !on {
                    self.unpublish(session, true).await;
                } else if self.screen.is_none() {
                    let key =
                        FeedKey::new(session.room.local_participant().identity().as_str(), true);
                    let (frames, commands) = (self.frames.clone(), self.commands.clone());
                    tokio::spawn(async move {
                        let ended = commands.clone();
                        let result = voice_capture::screen(frames, key, move || {
                            let _ = ended.unbounded_send(VoiceCommand::SetScreenShare {
                                on: false,
                                system_audio: false,
                            });
                        })
                        .await;
                        let _ = commands.unbounded_send(VoiceCommand::Captured {
                            screen: true,
                            result,
                        });
                    });
                }
                self.send_sync(session, UiState::Connected);
            }
            VoiceCommand::Captured { screen, result } => {
                let wanted = if screen {
                    self.want_screen
                } else {
                    self.want_camera
                };
                match result {
                    Ok(capture) if wanted => {
                        if let Err(error) = self.publish_video(session, capture, screen).await {
                            eprintln!("Could not publish video: {error}");
                            self.send(VoiceRoomEvent::CaptureFailed);
                        }
                    }
                    Ok(_) => {}
                    Err(error) => {
                        eprintln!("Could not start capture: {error}");
                        self.send(VoiceRoomEvent::CaptureFailed);
                    }
                }
                if screen {
                    self.want_screen = self.screen.is_some();
                } else {
                    self.want_camera = self.camera.is_some();
                }
                self.send_sync(session, UiState::Connected);
            }
        }
    }

    async fn publish_video(
        &mut self,
        session: &Session,
        capture: Capture,
        screen: bool,
    ) -> Result<(), String> {
        let options = TrackPublishOptions {
            source: if screen {
                TrackSource::Screenshare
            } else {
                TrackSource::Camera
            },
            simulcast: !screen,
            ..TrackPublishOptions::default()
        };
        let publication = session
            .room
            .local_participant()
            .publish_track(LocalTrack::Video(capture.track.clone()), options)
            .await
            .map_err(|error| error.to_string())?;
        let published = Some(Published {
            _capture: capture,
            sid: publication.sid(),
        });
        if screen {
            self.screen = published
        } else {
            self.camera = published
        }
        if screen && self.system_audio {
            self.publish_screen_audio(session).await;
        }
        Ok(())
    }

    /// Sharing goes on without sound if this fails, like the web.
    async fn publish_screen_audio(&mut self, session: &Session) {
        let audio = match crate::state::screen_audio::start().await {
            Ok(audio) => audio,
            Err(error) => return eprintln!("Could not capture system audio: {error}"),
        };
        let options = TrackPublishOptions {
            source: TrackSource::ScreenshareAudio,
            ..TrackPublishOptions::default()
        };
        match session
            .room
            .local_participant()
            .publish_track(LocalTrack::Audio(audio.track.clone()), options)
            .await
        {
            Ok(publication) => self.screen_audio = Some((audio, publication.sid())),
            Err(error) => eprintln!("Could not publish system audio: {error}"),
        }
    }

    async fn unpublish(&mut self, session: &Session, screen: bool) {
        let published = if screen {
            self.screen.take()
        } else {
            self.camera.take()
        };
        if let Some(published) = published {
            let _ = session
                .room
                .local_participant()
                .unpublish_track(&published.sid)
                .await;
        }
        if let Some((_, sid)) = self.screen_audio.take().filter(|_| screen) {
            let _ = session.room.local_participant().unpublish_track(&sid).await;
        }
    }

    fn watch_video(&mut self, track: RemoteVideoTrack, key: FeedKey) {
        let frames = self.frames.clone();
        let sid = track.sid();
        let task_key = key.clone();
        let task = tokio::spawn(async move {
            let mut stream = NativeVideoStream::new(track.rtc_track());
            while let Some(frame) = stream.next().await {
                frames.push_buffer(task_key.clone(), frame.buffer.as_ref());
            }
        });
        if let Some(old) = self.remote_video.insert(sid, RemoteVideo { key, task }) {
            old.task.abort();
        }
    }

    fn unwatch_video(&mut self, sid: &TrackSid) {
        if let Some(video) = self.remote_video.remove(sid) {
            video.task.abort();
            self.frames.push(video.key, None);
        }
    }

    /// The web's `attachRemoteAudio`/`detachRemoteAudio`: deafening silences everyone, and a
    /// per-participant mute or zero volume silences just them. (Volume scaling itself has no
    /// API on the native SDK's ADM playout, so only mute and 0 actually change anything.)
    /// The web's per-participant volume and mute (`attachRemoteAudio`), as gains in the mixer.
    fn apply_remote_audio(&self, session: &Session) {
        let Some(audio) = &self.audio else {
            return;
        };
        for participant in session.room.remote_participants().values() {
            for publication in participant.track_publications().values() {
                if matches!(publication.track(), Some(RemoteTrack::Audio(_))) {
                    let gain = self.gain(participant.identity().as_str(), publication.source());
                    audio.set_gain(publication.sid().as_str(), gain);
                }
            }
        }
    }

    async fn sync_subscriptions(&self, participant: &RemoteParticipant) {
        let watched = self.watched.contains(participant.identity().as_str());
        for publication in participant.track_publications().values() {
            let wanted = subscribable(publication.source(), watched);
            if publication.is_subscribed() != wanted {
                publication.set_subscribed(wanted);
            }
        }
    }

    /// None means the room is gone for good and the runner should go back to disconnected.
    async fn on_room_event(&mut self, session: &Session, event: RoomEvent) -> Option<()> {
        match event {
            RoomEvent::ParticipantConnected(participant) => {
                self.sync_subscriptions(&participant).await;
                self.send(VoiceRoomEvent::ParticipantJoined);
                self.send_sync(session, UiState::Connected);
            }
            RoomEvent::ParticipantDisconnected(participant) => {
                let identity = participant.identity().to_string();
                self.participant_audio.remove(identity.as_str());
                self.send(VoiceRoomEvent::ParticipantLeft(identity));
                self.send_sync(session, UiState::Connected);
            }
            RoomEvent::TrackPublished {
                publication,
                participant,
            } => {
                self.sync_subscriptions(&participant).await;
                self.send_semantic(
                    session,
                    participant.identity().to_string(),
                    false,
                    publication.source(),
                    true,
                );
                self.send_sync(session, UiState::Connected);
            }
            RoomEvent::TrackUnpublished {
                publication,
                participant,
            } => {
                self.send_semantic(
                    session,
                    participant.identity().to_string(),
                    false,
                    publication.source(),
                    false,
                );
                self.send_sync(session, UiState::Connected);
            }
            RoomEvent::TrackMuted {
                participant,
                publication,
            } => {
                self.send_semantic(
                    session,
                    participant.identity().to_string(),
                    matches!(participant, Participant::Local(_)),
                    publication.source(),
                    false,
                );
                // livekit mutes the mic on its own when the device drops out (sleep, unplug,
                // bluetooth), so turn it back on, or stay muted if that fails
                if matches!(participant, Participant::Local(_))
                    && publication.source() == TrackSource::Microphone
                    && !self.muted
                    && !self.deafened
                {
                    if let Some(mic) = &self.mic {
                        mic.unmute();
                    }
                }
                self.send_sync(session, UiState::Connected);
            }
            RoomEvent::TrackUnmuted {
                participant,
                publication,
            } => {
                self.send_semantic(
                    session,
                    participant.identity().to_string(),
                    matches!(participant, Participant::Local(_)),
                    publication.source(),
                    true,
                );
                self.send_sync(session, UiState::Connected);
            }
            RoomEvent::TrackSubscribed {
                track,
                publication,
                participant,
            } => {
                match track {
                    RemoteTrack::Video(track) => {
                        let screen = publication.source() == TrackSource::Screenshare;
                        let key = FeedKey::new(participant.identity().as_str(), screen);
                        self.watch_video(track, key);
                    }
                    RemoteTrack::Audio(track) => {
                        let gain = self.gain(participant.identity().as_str(), publication.source());
                        if let Some(audio) = &mut self.audio {
                            audio.add_remote(publication.sid().as_str(), track.rtc_track(), gain);
                        }
                    }
                }
                self.send_sync(session, UiState::Connected);
            }
            RoomEvent::TrackUnsubscribed { publication, .. } => {
                self.unwatch_video(&publication.sid());
                if let Some(audio) = &mut self.audio {
                    audio.remove_remote(publication.sid().as_str());
                }
                self.send_sync(session, UiState::Connected);
            }
            RoomEvent::ActiveSpeakersChanged { .. }
            | RoomEvent::ParticipantMetadataChanged { .. } => {
                self.send_sync(session, UiState::Connected)
            }
            RoomEvent::Reconnecting => self.send_sync(session, UiState::Reconnecting),
            RoomEvent::Reconnected => self.send_sync(session, UiState::Connected),
            RoomEvent::Disconnected { .. } => return None,
            // anything else still changes who's here or what they're publishing
            _ => self.send_sync(session, UiState::Connected),
        }
        Some(())
    }

    /// Call sounds that only make sense as events, not as snapshot diffs: someone's mic going
    /// quiet/loud (mute), or their share starting/stopping. Join/leave stay events too, because
    /// a first publication would otherwise sound like an unmute.
    fn send_semantic(
        &self,
        session: &Session,
        identity: String,
        is_local: bool,
        source: TrackSource,
        on: bool,
    ) {
        if is_local {
            return;
        }
        match source {
            TrackSource::Microphone => self.send(VoiceRoomEvent::MicChanged {
                identity,
                muted: !on,
            }),
            TrackSource::Camera => self.send(VoiceRoomEvent::CameraChanged { identity, on }),
            TrackSource::Screenshare => {
                // a share nobody ever subscribed to still counts as "on" if it's live
                let publishing = session
                    .room
                    .remote_participants()
                    .values()
                    .any(|participant| {
                        participant.identity().as_str() == identity.as_str()
                            && participant
                                .track_publications()
                                .into_values()
                                .any(|publication| {
                                    publication.source() == TrackSource::Screenshare
                                        && !publication.is_muted()
                                })
                    });
                self.send(VoiceRoomEvent::ScreenChanged {
                    identity,
                    on: on || publishing,
                });
            }
            _ => {}
        }
    }

    /// The web's `syncParticipant` for everyone at once.
    fn snapshot(&self, session: &Session, state: UiState) -> Snapshot {
        let mut states = VoiceStates::new();
        let mut handles = HashMap::new();

        let local = session.room.local_participant();
        states.insert(
            local.identity().to_string(),
            crate::state::voice::VoiceState {
                speaking: local.is_speaking(),
                self_muted: self.muted,
                self_deafened: self.deafened,
                camera: self.camera.is_some(),
                screen_share: self.screen.is_some(),
            },
        );

        for (identity, participant) in session.room.remote_participants() {
            if let Some(handle) = parse_handle(&participant.metadata()) {
                handles.insert(identity.to_string(), handle);
            }
            let mic = participant
                .track_publications()
                .into_values()
                .find(|publication| publication.source() == TrackSource::Microphone);
            let screen = participant
                .track_publications()
                .into_values()
                .find(|publication| publication.source() == TrackSource::Screenshare);
            let camera = participant
                .track_publications()
                .into_values()
                .find(|publication| publication.source() == TrackSource::Camera);
            states.insert(
                identity.to_string(),
                crate::state::voice::VoiceState {
                    speaking: participant.is_speaking(),
                    self_muted: mic.is_none_or(|publication| publication.is_muted()),
                    self_deafened: false,
                    camera: camera.is_some_and(|publication| !publication.is_muted()),
                    screen_share: screen.is_some_and(|publication| !publication.is_muted()),
                },
            );
        }

        Snapshot {
            connection_state: state,
            local_identity: Some(local.identity().to_string()),
            states,
            handles,
        }
    }

    async fn teardown(&mut self) {
        self.attempt += 1;
        self.mic = None;
        self.audio = None;
        self.camera = None;
        self.screen = None;
        self.screen_audio = None;
        for sid in self.remote_video.keys().cloned().collect::<Vec<_>>() {
            self.unwatch_video(&sid);
        }
    }
}

/// Spawns the voice room. `commands` drives it, `events` feeds the UI entity. Commands that need
/// a live room are dropped while disconnected; the UI entity keeps that state on its own.
pub fn spawn(
    frames: FrameSink,
) -> (
    mpsc::UnboundedSender<VoiceCommand>,
    mpsc::UnboundedReceiver<VoiceRoomEvent>,
) {
    let (commands_tx, mut commands) = mpsc::unbounded();
    let actor_commands = commands_tx.clone();
    let (events, events_rx) = mpsc::unbounded();
    runtime::handle().spawn(async move {
        let mut actor = Actor {
            events,
            channel_id: String::new(),
            audio: None,
            mic: None,
            muted: false,
            deafened: false,
            processing: AudioProcessing {
                echo_cancellation: true,
                auto_gain_control: true,
                noise: None,
                noise_level: None,
            },
            devices: AudioDevices {
                input: "default".into(),
                output: "default".into(),
            },
            participant_audio: HashMap::new(),
            watched: HashSet::new(),
            attempt: 0,
            frames,
            commands: actor_commands,
            camera: None,
            screen: None,
            want_camera: false,
            want_screen: false,
            system_audio: false,
            screen_audio: None,
            remote_video: HashMap::new(),
        };

        loop {
            // disconnected: only a Join (or shutdown) means anything
            let (channel_id, options) = loop {
                match commands.next().await {
                    Some(VoiceCommand::Join {
                        channel_id,
                        options,
                    }) => break (channel_id, options),
                    Some(VoiceCommand::Leave) | None => return,
                    Some(_) => {}
                }
            };
            actor.apply_join(channel_id, options);
            let mut session = match actor.dial().await {
                Ok(session) => session,
                Err(()) => {
                    actor.teardown().await;
                    actor.send(VoiceRoomEvent::Left);
                    continue;
                }
            };
            actor.send_sync(&session, UiState::Connected);

            // connected: serve commands and room events until either side ends the call
            let pending = loop {
                tokio::select! {
                    command = commands.next() => match command {
                        Some(VoiceCommand::Join { channel_id, options }) => {
                            break Some((channel_id, options));
                        }
                        Some(VoiceCommand::Leave) | None => break None,
                        Some(command) => actor.on_command(&session, command).await,
                    },
                    event = session.events.recv() => match event {
                        Some(event) => {
                            if actor.on_room_event(&session, event).await.is_none() {
                                break None;
                            }
                        }
                        None => break None,
                    }
                }
            };

            actor.teardown().await;
            let _ = session.room.close().await;
            match pending {
                Some((channel_id, options)) => {
                    actor.apply_join(channel_id, options);
                    session = match actor.dial().await {
                        Ok(session) => session,
                        Err(()) => {
                            actor.teardown().await;
                            actor.send(VoiceRoomEvent::Left);
                            continue;
                        }
                    };
                    actor.send_sync(&session, UiState::Connected);
                }
                None => {
                    actor.send(VoiceRoomEvent::Left);
                }
            }
        }
    });
    (commands_tx, events_rx)
}
