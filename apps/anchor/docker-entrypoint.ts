const run = async (cmd: string[]) => {
  const child = Bun.spawn(cmd, {
    cwd: '/app/apps/anchor',
    env: process.env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const forwardSigint = () => child.kill('SIGINT');
  const forwardSigterm = () => child.kill('SIGTERM');

  process.on('SIGINT', forwardSigint);
  process.on('SIGTERM', forwardSigterm);

  const exitCode = await child.exited;

  process.off('SIGINT', forwardSigint);
  process.off('SIGTERM', forwardSigterm);

  return exitCode;
};

const migrateExitCode = await run([
  process.execPath,
  '/app/node_modules/@prisma-next/cli/dist/cli.js',
  'migrate',
]);

if (migrateExitCode !== 0) {
  process.exit(migrateExitCode);
}

process.exit(await run([process.execPath, 'src/index.ts']));
