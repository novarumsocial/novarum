#!/usr/bin/env -S node
import endContract from './end-contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  col,
  placeholder,
  primaryKey,
} from '@prisma-next/postgres/migration';

export default class M extends Migration {
  override describe() {
    return {
      from: 'sha256:91be4996d337c5ed937c132ceba29e2c09b7a0052b0f7597d4710b18a0b5a5b1',
      to: 'sha256:3f8c1ec46cef390e382511499ef04955856105ec75cdb61ca05a74e8f353a95f',
    };
  }

  override get operations() {
    return [
      this.dropConstraint({ schema: 'public', table: 'user', constraint: 'unique(email)' }),
      this.dropColumn({ schema: 'public', table: 'user', column: 'email' }),
      this.dropColumn({ schema: 'public', table: 'user', column: 'passwordHash' }),
      this.createTable({
        schema: 'public',
        table: 'local_credential',
        columns: [
          col('email', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('passwordHash', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('userId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['userId'])],
      }),
      this.addColumn({
        schema: 'public',
        table: 'user',
        column: col('avatarUrl', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'user',
        column: col('displayName', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'user',
        column: col('createdAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz@1' } }),
      }),
      this.dataTransform(endContract, 'backfill-user-createdAt', {
        check: () => placeholder('backfill-user-createdAt:check'),
        run: () => placeholder('backfill-user-createdAt:run'),
      }),
      this.setNotNull({ schema: 'public', table: 'user', column: 'createdAt' }),
      this.addColumn({
        schema: 'public',
        table: 'user',
        column: col('homeserverName', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.dataTransform(endContract, 'backfill-user-homeserverName', {
        check: () => placeholder('backfill-user-homeserverName:check'),
        run: () => placeholder('backfill-user-homeserverName:run'),
      }),
      this.setNotNull({ schema: 'public', table: 'user', column: 'homeserverName' }),
      this.addColumn({
        schema: 'public',
        table: 'user',
        column: col('isBot', 'bool', { codecRef: { codecId: 'pg/bool@1' } }),
      }),
      this.dataTransform(endContract, 'backfill-user-isBot', {
        check: () => placeholder('backfill-user-isBot:check'),
        run: () => placeholder('backfill-user-isBot:run'),
      }),
      this.setNotNull({ schema: 'public', table: 'user', column: 'isBot' }),
      this.addColumn({
        schema: 'public',
        table: 'user',
        column: col('updatedAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz@1' } }),
      }),
      this.dataTransform(endContract, 'backfill-user-updatedAt', {
        check: () => placeholder('backfill-user-updatedAt:check'),
        run: () => placeholder('backfill-user-updatedAt:run'),
      }),
      this.setNotNull({ schema: 'public', table: 'user', column: 'updatedAt' }),
      this.addColumn({
        schema: 'public',
        table: 'user',
        column: col('username', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.dataTransform(endContract, 'backfill-user-username', {
        check: () => placeholder('backfill-user-username:check'),
        run: () => placeholder('backfill-user-username:run'),
      }),
      this.setNotNull({ schema: 'public', table: 'user', column: 'username' }),
      this.addUnique({
        schema: 'public',
        table: 'local_credential',
        constraint: 'local_credential_email_key',
        columns: ['email'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'user',
        constraint: 'user_username_homeserverName_key',
        columns: ['username', 'homeserverName'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'local_credential',
        index: 'local_credential_userId_idx',
        columns: ['userId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'local_credential',
        foreignKey: {
          name: 'local_credential_userId_fkey',
          columns: ['userId'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
