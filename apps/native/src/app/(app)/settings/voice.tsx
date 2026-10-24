// Port of the "voice" tab of apps/frontend/src/lib/components/settings-dialog.svelte
// Native differences: device pickers become the phone's audio output (speaker / earpiece / Bluetooth) and front/back camera,
// and there is no screen sharing section yet.
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { MicLevelMeter } from '@/components/mic-level-meter';
import { SettingsGroup, SettingsPage } from '@/components/settings-group';
import { SettingsRow } from '@/components/settings-row';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { useSettings } from '@/lib/settings';
import { MicModes } from '../../../../modules/mic-modes';
import { useVoice, voice, type AudioOutput, type CameraFacing } from '@/lib/voice';
import { ConnectionState } from 'livekit-client';

const outputLabels: Record<AudioOutput, string> = {
  speaker: 'Speaker',
  earpiece: 'Earpiece',
  bluetooth: 'Bluetooth',
};

function Choice<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <View className="flex-row gap-2">
      {options.map((option) => (
        <Button
          key={option.value}
          variant={option.value === value ? 'default' : 'outline'}
          size="sm"
          className="flex-1"
          onPress={() => onChange(option.value)}
        >
          <Text>{option.label}</Text>
        </Button>
      ))}
    </View>
  );
}

export default function VoiceSettings() {
  const echo = useSettings((s) => s.voiceEchoCancellation);
  const gain = useSettings((s) => s.voiceAutoGainControl);
  const noise = useSettings((s) => s.noiseCancellation);
  const othersCallSounds = useSettings((s) => s.othersCallSounds);
  const update = useSettings((s) => s.update);
  const audioOutput = useVoice((s) => s.audioOutput);
  const audioOutputs = useVoice((s) => s.audioOutputs);
  const cameraFacing = useVoice((s) => s.cameraFacing);
  const testing = useVoice((s) => s.audioLoopbackTesting);
  const inCall = useVoice((s) => s.connectionState === ConnectionState.Connected);
  const testTrack = useVoice((s) => s.audioLoopbackTrack);
  const [deviceError, setDeviceError] = useState<string | null>(null);

  // the mic test stops when you leave the screen
  useEffect(() => () => void voice().setAudioLoopbackTesting(false), []);

  // before the first call the phone has not listed its outputs yet
  const outputs = audioOutputs.length ? audioOutputs : (['speaker', 'earpiece'] as AudioOutput[]);

  async function run(action: () => Promise<void>, error: string) {
    setDeviceError(null);
    try {
      await action();
    } catch {
      setDeviceError(error);
    }
  }

  return (
    <SettingsPage description="Pick how you hear others and how your voice is processed.">
      <SettingsGroup title="Devices">
        <SettingsRow
          title="Audio output"
          description="Where you hear calls. Applies when you join a call."
          stacked
        >
          <Choice
            options={outputs.map((value) => ({ value, label: outputLabels[value] }))}
            value={audioOutput}
            onChange={(value) =>
              run(() => voice().setAudioOutput(value), 'Could not switch to that audio output.')
            }
          />
        </SettingsRow>
        <SettingsRow title="Camera" stacked>
          <Choice<CameraFacing>
            options={[
              { value: 'user', label: 'Front' },
              { value: 'environment', label: 'Back' },
            ]}
            value={cameraFacing}
            onChange={(value) =>
              run(() => voice().setCameraFacing(value), 'Could not switch to that camera.')
            }
          />
        </SettingsRow>
        {deviceError ? (
          <Text className="px-4 py-2 text-xs text-destructive" accessibilityLiveRegion="polite">
            {deviceError}
          </Text>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="Voice processing">
        <SettingsRow
          title="Echo cancellation"
          description="Turn off if it interferes with noise suppression."
        >
          <Switch value={echo} onValueChange={(value) => void voice().setEchoCancellation(value)} />
        </SettingsRow>
        <SettingsRow
          title="Automatic gain control"
          description="Keep your microphone volume steady."
        >
          <Switch value={gain} onValueChange={(value) => void voice().setAutoGainControl(value)} />
        </SettingsRow>
        <SettingsRow title="Noise suppression" description="Reduce background noise.">
          <Switch
            value={noise}
            onValueChange={(value) => void voice().setNoiseCancellation(value)}
          />
        </SettingsRow>
        {MicModes ? (
          <SettingsRow
            title="Voice Isolation"
            description="Apple's mic mode that filters out everything but your voice. Available while you're in a call or testing your mic."
            stacked
          >
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              disabled={!inCall && !testing}
              onPress={() => MicModes?.showPicker()}
            >
              <Text>Choose mic mode</Text>
            </Button>
          </SettingsRow>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="Sound effects">
        <SettingsRow
          title="Others' sound effects"
          description="Play a sound when others join, leave, mute, or turn on their camera or screen."
        >
          <Switch
            value={othersCallSounds}
            onValueChange={(value) => update({ othersCallSounds: value })}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        title="Microphone test"
        description="Talk to see your level. Nothing is played back."
      >
        <View className="gap-3 px-4 py-3.5">
          <MicLevelMeter track={testTrack} />
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            onPress={() =>
              run(
                () => voice().setAudioLoopbackTesting(!testing),
                'Could not start the microphone test.'
              )
            }
          >
            <Text>{testing ? 'Stop test' : 'Test microphone'}</Text>
          </Button>
        </View>
      </SettingsGroup>
    </SettingsPage>
  );
}
