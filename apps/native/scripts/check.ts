// Native-only: `tsc` also type-checks Anchor's server files (we import its types), and those clash with
// React Native's globals. Only errors in apps/native count here; Anchor is checked by its own setup.
const tsc = Bun.spawn(['bunx', 'tsc', '--noEmit', '--pretty', 'false'], { stdout: 'pipe' });
const output = await new Response(tsc.stdout).text();
await tsc.exited;

// tsc prints continuation lines for an error indented, so they follow the file their error belongs to
let inOwnFile = false;
const own = output.split('\n').filter((line) => {
  if (!line.startsWith(' ')) inOwnFile = Boolean(line) && !line.startsWith('../');
  return inOwnFile;
});

if (own.length) console.error(own.join('\n'));
else console.log('No type errors in apps/native');
process.exit(own.length ? 1 : 0);
