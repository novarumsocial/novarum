import { TOML } from 'bun';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { anchorRoot, s3Endpoint, smtpPort, livekitUrl } from './env';

type Json = string | number | boolean | Json[] | { [key: string]: Json };

const value = (v: Json): string =>
  Array.isArray(v) ? `[${v.map(value).join(', ')}]` : JSON.stringify(v);

/** tiny TOML writer: tables of scalars/arrays, which is all anchor's config uses */
export function stringifyToml(data: Record<string, Record<string, Json>>) {
  return Object.entries(data)
    .map(
      ([table, entries]) =>
        `[${table}]\n${Object.entries(entries)
          .map(([k, v]) => `${k} = ${value(v)}`)
          .join('\n')}\n`
    )
    .join('\n');
}

export type ConfigOverrides = {
  server?: Record<string, Json>;
  federation?: Record<string, Json>;
  files?: Record<string, Json>;
  misc?: Record<string, Json>;
  network?: Record<string, Json>;
  voice?: Record<string, Json>;
  email?: Record<string, Json>;
};

/** reads test/config.toml, applies overrides, writes it to dir/config.toml and returns the path */
export function writeConfig(dir: string, overrides: ConfigOverrides) {
  const base = TOML.parse(
    readFileSync(path.join(anchorRoot, 'test/config.toml')).toString()
  ) as Record<string, Record<string, Json>>;
  base.files!.s3_endpoint = s3Endpoint;
  base.email!.smtp_port = smtpPort;
  base.voice!.livekit_url = livekitUrl;
  for (const [table, entries] of Object.entries(overrides)) {
    base[table] = { ...base[table], ...entries };
  }
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.toml');
  writeFileSync(file, stringifyToml(base));
  return file;
}
