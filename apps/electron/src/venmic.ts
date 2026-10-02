import { createRequire } from 'node:module';
import { app, ipcMain } from 'electron';

// @vencord/venmic ships a native pipewire addon and only targets linux (see its
// package.json "os" field) - it isn't even installed on other platforms, so this
// has to stay behind a dynamic require rather than a static import, and the whole
// module below is a no-op everywhere except linux.
const nodeRequire = createRequire(import.meta.url);

type VenmicNode = Record<string, string>;

interface VenmicPatchBay {
  unlink(): void;
  unmute(): void;
  link(data: { include: VenmicNode[]; exclude: VenmicNode[]; mute?: boolean }): boolean;
}

interface VenmicModule {
  PatchBay: { new (): VenmicPatchBay; hasPipeWire(): boolean };
}

let venmic: VenmicModule | undefined;
let patchBay: VenmicPatchBay | undefined;
let importAttempted = false;

function importVenmic() {
  if (importAttempted) return venmic;
  importAttempted = true;

  if (process.platform !== 'linux') return undefined;

  try {
    const mod = nodeRequire('@vencord/venmic') as VenmicModule;
    if (mod.PatchBay.hasPipeWire()) venmic = mod;
  } catch (error) {
    console.error('Failed to load @vencord/venmic', error);
  }

  return venmic;
}

function obtainPatchBay() {
  const mod = importVenmic();
  if (!mod) return undefined;

  if (!patchBay) {
    try {
      patchBay = new mod.PatchBay();
    } catch (error) {
      console.error('Failed to start venmic patch bay', error);
      return undefined;
    }
  }

  return patchBay;
}

function ownAudioServicePid() {
  return app
    .getAppMetrics()
    .find((proc) => proc.name === 'Audio Service')
    ?.pid?.toString();
}

export function registerVenmicHandlers() {
  ipcMain.handle('venmic:available', () => !!importVenmic());

  ipcMain.handle('venmic:link', () => {
    const bay = obtainPatchBay();
    if (!bay) return false;

    const ownPid = ownAudioServicePid();
    const exclude: VenmicNode[] = [{ 'media.class': 'Stream/Input/Audio' }];
    if (ownPid) exclude.push({ 'application.process.id': ownPid });

    // include: [] links every node that isn't excluded above, i.e. "whole system audio".
    return bay.link({ include: [], exclude, mute: false });
  });

  ipcMain.handle('venmic:unlink', () => {
    patchBay?.unlink();
  });
}

export function shutdownVenmic() {
  patchBay?.unlink();
}
