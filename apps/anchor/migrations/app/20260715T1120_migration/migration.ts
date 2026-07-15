#!/usr/bin/env -S node
import endContract from './end-contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, placeholder } from '@prisma-next/postgres/migration';

export default class M extends Migration {
  override describe() {
    return {
      from: 'sha256:28d29df53d9611f9ec50511126e930a304552e355a94ad45275761d145238fd1',
      to: 'sha256:518db60751f94effbcfded5114e111bd16a78d9d37518fae36a2e5df3bf9e005',
    };
  }

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'message',
        column: col('replyTo', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.dataTransform(endContract, 'backfill-message-replyTo', {
        check: () => placeholder('backfill-message-replyTo:check'),
        run: () => placeholder('backfill-message-replyTo:run'),
      }),
      this.setNotNull({ schema: 'public', table: 'message', column: 'replyTo' }),
      this.createIndex({
        schema: 'public',
        table: 'local_credential',
        index: 'local_credential_userId_idx',
        columns: ['userId'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
