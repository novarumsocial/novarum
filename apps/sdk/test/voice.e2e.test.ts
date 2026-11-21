import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawnAnchor, type RunningAnchor } from '../../anchor/test/harness/anchor';
import { signup } from '../../anchor/test/harness/users';
import { call, createGuild } from '../../anchor/test/harness/chat';
import { dispose } from '@livekit/rtc-node';
import { Client } from '../src/index';
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  StreamType,
} from '../src/voice/index';

// Voice against a real Anchor and LiveKit (`docker compose -f ../anchor/test/compose.yml --profile livekit up -d`):
// run with `bun run test:voice`.
setDefaultTimeout(60_000);

let anchor: RunningAnchor;
beforeAll(async () => {
  anchor = await spawnAnchor({ name: 'sdkvoice' });
});
afterAll(async () => {
  anchor.destroy();
  await dispose();
});

async function bot(owner: Awaited<ReturnType<typeof signup>>, guildId: string) {
  const created = await call(owner, 'POST', '/developers/bots', {
    username: `vox${crypto.randomUUID().slice(0, 8)}`,
  });
  await call(owner, 'POST', `/guilds/${guildId}/bots`, {
    username: created.body.bot.username,
    homeserver: created.body.bot.homeserver,
  });
  const client = new Client({ token: created.body.token, baseUrl: anchor.url, reconnect: false });
  await client.login();
  return client;
}

// one second of a 440Hz tone as 48kHz stereo s16le
function tone(seconds: number) {
  const pcm = Buffer.alloc(48_000 * seconds * 4);
  for (let i = 0; i < 48_000 * seconds; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / 48_000) * 16_000);
    pcm.writeInt16LE(sample, i * 4);
    pcm.writeInt16LE(sample, i * 4 + 2);
  }
  return pcm;
}

const loudest = (pcm: Buffer) => {
  let max = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) max = Math.max(max, Math.abs(pcm.readInt16LE(i)));
  return max;
};

test('a bot plays audio into a call and another bot hears it', async () => {
  const owner = await signup(anchor.url);
  const { guild } = await createGuild(owner);
  const voice = (
    await call(owner, 'POST', '/channel/create', {
      name: 'voice',
      guildId: guild.id,
      type: 'VOICE',
    })
  ).body;
  const [speaker, listener] = await Promise.all([bot(owner, guild.id), bot(owner, guild.id)]);

  const speakerConnection = await joinVoiceChannel(speaker, voice.id);
  const listenerConnection = await joinVoiceChannel(listener.rest, voice.id);
  expect(speakerConnection.status).toBe('ready');

  const heard: Buffer[] = [];
  const stream = listenerConnection.receiver.subscribe(speaker.user!.id);
  stream.on('data', (chunk: Buffer) => heard.push(chunk));
  const speaking = new Promise((resolve) =>
    listenerConnection.receiver.once('speakingStart', resolve)
  );

  const player = createAudioPlayer();
  speakerConnection.subscribe(player);
  const startedAt = Date.now();
  player.play(createAudioResource(Readable.from([tone(2)]), { inputType: StreamType.Raw }));
  expect(player.status).toBe(AudioPlayerStatus.Playing);
  await new Promise((resolve) => player.once('idle', resolve));

  // paced in real time, not dumped at once
  expect(Date.now() - startedAt).toBeGreaterThan(1500);
  expect(await speaking).toBe(speaker.user!.id);
  expect(loudest(Buffer.concat(heard))).toBeGreaterThan(5000);

  stream.destroy();
  await Promise.all([speakerConnection.destroy(), listenerConnection.destroy()]);
  speaker.destroy();
  listener.destroy();
});

test('decodes files through ffmpeg, pauses and stops', async () => {
  const owner = await signup(anchor.url);
  const { guild } = await createGuild(owner);
  const voice = (
    await call(owner, 'POST', '/channel/create', {
      name: 'voice',
      guildId: guild.id,
      type: 'VOICE',
    })
  ).body;
  const client = await bot(owner, guild.id);
  const connection = await joinVoiceChannel(client, voice.id);

  const pcm = tone(3);
  const wav = Buffer.concat([wavHeader(pcm.length), pcm]);
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'sdk-voice-')), 'tone.wav');
  writeFileSync(file, wav);

  const player = createAudioPlayer();
  connection.subscribe(player);
  const resource = createAudioResource(file, { metadata: 'tone' });
  player.play(resource);
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(player.pause()).toBe(true);
  const paused = resource.playbackDuration;
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(resource.playbackDuration - paused).toBeLessThanOrEqual(20);
  expect(player.unpause()).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(resource.playbackDuration).toBeGreaterThan(paused);
  expect(player.stop()).toBe(true);
  expect(player.status).toBe(AudioPlayerStatus.Idle);

  await connection.destroy();
  client.destroy();
});

test('refuses channels the bot cannot reach', async () => {
  const owner = await signup(anchor.url);
  const { guild } = await createGuild(owner);
  const elsewhere = await createGuild(owner);
  const voice = (
    await call(owner, 'POST', '/channel/create', {
      name: 'voice',
      guildId: elsewhere.guild.id,
      type: 'VOICE',
    })
  ).body;
  const client = await bot(owner, guild.id);
  await expect(joinVoiceChannel(client, voice.id)).rejects.toThrow('401');
  client.destroy();
});

function wavHeader(size: number) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + size, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(48_000, 24);
  header.writeUInt32LE(48_000 * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(size, 40);
  return header;
}
