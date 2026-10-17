// Short UI sounds (expo-audio). On iOS a player deactivates the shared audio session once it finishes, and that
// also stops WebRTC's audio engine: during a call the mic and everyone else go silent until the call is rebuilt
// (https://github.com/react-native-webrtc/react-native-webrtc/pull/1845). So during a call the players leave the
// session to LiveKit.
import { createAudioPlayer } from 'expo-audio';

let inCall = false;
// kept in sync by voice.ts
export const setInCall = (value: boolean) => {
  inCall = value;
};

const players = new Map<string, ReturnType<typeof createAudioPlayer>>();

export function playSound(source: number, volume = 1, keepAudioSessionActive = inCall) {
  const key = `${source}:${keepAudioSessionActive}`;
  const player = players.get(key) ?? createAudioPlayer(source, { keepAudioSessionActive });
  players.set(key, player);
  player.volume = volume;
  void player.seekTo(0);
  player.play();
}
