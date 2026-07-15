#!/usr/bin/env -S node
import { Migration, MigrationCLI } from '@prisma-next/postgres/migration';

export default class M extends Migration {
  override describe() {
    return {
      from: 'sha256:518db60751f94effbcfded5114e111bd16a78d9d37518fae36a2e5df3bf9e005',
      to: 'sha256:9ab74198e40d6ea166f71e23a24bc88ea6354fd100d9b480e0dbfb56554deb35',
    };
  }

  override get operations() {
    return [
      this.dropNotNull({ schema: 'public', table: 'message', column: 'replyTo' }),
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
