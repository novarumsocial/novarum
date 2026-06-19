export const version =
  'v' + (await Bun.file(new URL('../package.json', import.meta.url)).json()).version;
