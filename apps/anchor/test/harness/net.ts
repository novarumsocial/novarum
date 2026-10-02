import { execSync } from 'node:child_process';

/** runs shell commands (newline separated) at boot of an in-container harness process; throws on failure */
export const runSetup = (script = '') => {
  for (const cmd of script.split('\n').map((c) => c.trim()).filter(Boolean)) {
    console.log(`[setup] ${cmd}`);
    execSync(cmd, { stdio: 'inherit' });
  }
};

/** adds an address (`ip/prefix`) to the interface that already holds an address in the same /24, or to `lo` when no match */
export const addIp = (cidr: string) => {
  const [ip] = cidr.split('/');
  const prefix = ip!.split('.').slice(0, 3).join('.') + '.';
  const iface = execSync('ip -o -4 addr show', { encoding: 'utf8' })
    .split('\n')
    .map((l) => l.split(/\s+/))
    .find((f) => f[3]?.startsWith(prefix))?.[1];
  execSync(`ip addr add ${cidr} dev ${iface ?? 'lo'}`, { stdio: 'inherit' });
};

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
