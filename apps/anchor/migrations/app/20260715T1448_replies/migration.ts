#!/usr/bin/env -S node
import { Migration, MigrationCLI, col } from '@prisma-next/postgres/migration';

export default class M extends Migration {
  override describe() {
    return {
      from: 'sha256:28d29df53d9611f9ec50511126e930a304552e355a94ad45275761d145238fd1',
      to: 'sha256:9ab74198e40d6ea166f71e23a24bc88ea6354fd100d9b480e0dbfb56554deb35',
    };
  }

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'message',
        column: col('replyTo', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
