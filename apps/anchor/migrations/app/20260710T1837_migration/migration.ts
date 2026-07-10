#!/usr/bin/env -S node
import { Migration, MigrationCLI, col, fn, lit, primaryKey } from '@prisma-next/postgres/migration';

export default class M extends Migration {
  override describe() {
    return {
      from: 'sha256:997f145d5109c84fce252ed4940e218527a58b21a9b521ea2fafd5dc7629c911',
      to: 'sha256:28d29df53d9611f9ec50511126e930a304552e355a94ad45275761d145238fd1',
    };
  }

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'attachment',
        columns: [
          col('channelId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('contentType', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz@1' },
          }),
          col('filename', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('messageId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('objectKey', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('size', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('PENDING'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('uploaderId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addUnique({
        schema: 'public',
        table: 'attachment',
        constraint: 'attachment_objectKey_key',
        columns: ['objectKey'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'attachment',
        index: 'attachment_uploaderId_status_idx',
        columns: ['uploaderId', 'status'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'attachment',
        index: 'attachment_channelId_idx',
        columns: ['channelId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'attachment',
        index: 'attachment_messageId_idx',
        columns: ['messageId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'attachment',
        index: 'attachment_uploaderId_idx',
        columns: ['uploaderId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'local_credential',
        index: 'local_credential_userId_idx',
        columns: ['userId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'attachment',
        foreignKey: {
          name: 'attachment_uploaderId_fkey',
          columns: ['uploaderId'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'attachment',
        foreignKey: {
          name: 'attachment_channelId_fkey',
          columns: ['channelId'],
          references: { schema: 'public', table: 'channel', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'attachment',
        foreignKey: {
          name: 'attachment_messageId_fkey',
          columns: ['messageId'],
          references: { schema: 'public', table: 'message', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
