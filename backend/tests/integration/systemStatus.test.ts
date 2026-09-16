import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemStatusResponseSchema } from '@ekon/shared';
import { buildApp } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config/index.js';
import { fixedClock } from '../../src/platform/clock/index.js';
import { loadMigrations } from '../../src/platform/db/migrator.js';
import { writeLastBackup } from '../../src/platform/installation/backupState.js';
import { createTestSession } from '../helpers/authSession.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * `GET /api/system/status` — how the installation says it is doing.
 *
 * On a computer in a shop there is no provider taking snapshots and no console
 * to open, so the questions an operator would ask infrastructure have to be
 * answerable from inside the application. The most important of them is whether
 * a backup actually finished, which is why a *failed* backup is a reported
 * result here and not an absence.
 */

const NOW = new Date('2026-09-15T12:00:00.000Z');

describe('GET /api/system/status', () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let stateDir: string;
  let backupDir: string;
  let headVersion: string;
  let owner: Awaited<ReturnType<typeof createTestSession>>;
  let manager: Awaited<ReturnType<typeof createTestSession>>;
  let employee: Awaited<ReturnType<typeof createTestSession>>;

  beforeAll(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'ekon-state-'));
    backupDir = await mkdtemp(path.join(tmpdir(), 'ekon-backups-'));

    const migrations = await loadMigrations();
    const latest = migrations.at(-1)?.version;
    if (!latest) throw new Error('No migrations found');
    headVersion = latest;

    db = await createTestDatabase();

    const config: Config = {
      ...loadConfig(),
      LOG_LEVEL: 'silent',
      APP_VERSION: '1.4.0',
      DEPLOYMENT_PROFILE: 'local',
      EKON_STATE_DIR: stateDir,
      EKON_BACKUP_DIR: backupDir,
    };

    app = await buildApp({ config, pool: db.appPool, clock: fixedClock(NOW) });

    // Sessions that begin when the pinned clock says it is, so all three are
    // comfortably inside their twelve hours at the moment a request arrives.
    owner = await createTestSession(db.pool, { role: 'OWNER', createdAt: NOW });
    manager = await createTestSession(db.pool, { role: 'MANAGER', createdAt: NOW });
    employee = await createTestSession(db.pool, { role: 'EMPLOYEE', createdAt: NOW });
  });

  afterAll(async () => {
    await app.close();
    await db.drop();
    await rm(stateDir, { recursive: true, force: true });
    await rm(backupDir, { recursive: true, force: true });
  });

  const status = (cookies?: Record<string, string>) =>
    app.inject({ method: 'GET', url: '/api/system/status', ...(cookies ? { cookies } : {}) });

  describe('who may ask', () => {
    it('refuses an anonymous caller', async () => {
      expect((await status()).statusCode).toBe(401);
    });

    it('refuses an employee and a manager', async () => {
      // Not `inventory.read` and not `audit.read`: "when was the last backup"
      // is also the answer to "how much would be lost", and the person who acts
      // on a failed backup is the person who owns the records.
      expect((await status(employee.cookies)).statusCode).toBe(403);
      expect((await status(manager.cookies)).statusCode).toBe(403);
    });

    it('answers an owner', async () => {
      expect((await status(owner.cookies)).statusCode).toBe(200);
    });
  });

  describe('what it reports', () => {
    it('reports the build, the schema the database is actually at, and the profile', async () => {
      const body = systemStatusResponseSchema.parse((await status(owner.cookies)).json());
      expect(body.appVersion).toBe('1.4.0');
      // From the database, not from what this build expected: when the two
      // disagree, the database's answer is the useful one.
      expect(body.schemaVersion).toBe(headVersion);
      expect(body.profile).toBe('local');
    });

    it('says there is no backup when none has ever run', async () => {
      const body = systemStatusResponseSchema.parse((await status(owner.cookies)).json());
      expect(body.lastBackup).toBeNull();
    });

    it('reports free space where backups are written', async () => {
      const body = systemStatusResponseSchema.parse((await status(owner.cookies)).json());
      // A dump that runs out of disk is the failure nobody sees coming: it is
      // silent, it happens at three in the morning, and the first sign of it is
      // a restore with nothing to restore from.
      expect(body.backupDirFreeBytes).toBeGreaterThan(0);
    });

    it('reports a successful backup', async () => {
      await writeLastBackup(stateDir, {
        finishedAt: '2026-09-15T03:15:00.000Z',
        ok: true,
        file: 'ekon-20260915T031500Z.dump',
        bytes: 40_960,
        error: null,
      });

      const body = systemStatusResponseSchema.parse((await status(owner.cookies)).json());
      expect(body.lastBackup).toEqual({
        finishedAt: '2026-09-15T03:15:00.000Z',
        ok: true,
        file: 'ekon-20260915T031500Z.dump',
      });
    });

    it('reports a failed backup as a result, not as an absence', async () => {
      // The whole point. A backup that ran and failed, reported as "no backup
      // yet", reads on a screen exactly like a shop that has not got round to
      // it — and both get shrugged at.
      await writeLastBackup(stateDir, {
        finishedAt: '2026-09-16T03:15:00.000Z',
        ok: false,
        file: null,
        bytes: null,
        error: 'pg_dump exited with code 1: could not connect',
      });

      const body = systemStatusResponseSchema.parse((await status(owner.cookies)).json());
      expect(body.lastBackup).toEqual({
        finishedAt: '2026-09-16T03:15:00.000Z',
        ok: false,
        file: null,
      });
    });

    it('keeps the database tool’s error text off the screen', async () => {
      // English, technical, and nothing a shop can act on. It stays in
      // last-backup.json and in the diagnostics bundle, where support reads it.
      const response = await status(owner.cookies);
      expect(response.body).not.toContain('could not connect');
    });

    it('never puts a path on the wire', async () => {
      // A path would tell a caller where the business's records are kept, and
      // answers no question the screen asks.
      const response = await status(owner.cookies);
      expect(response.body).not.toContain(stateDir);
      expect(response.body).not.toContain(backupDir);
    });

    it('carries nothing about the business', async () => {
      // No counts of products, movements, or users; no names; no connection
      // string. Five facts about the machine, and the strict schema is what
      // keeps a sixth from arriving unnoticed.
      const body = (await status(owner.cookies)).json() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual([
        'appVersion',
        'backupDirFreeBytes',
        'lastBackup',
        'profile',
        'schemaVersion',
      ]);
    });

    it('survives a state file nothing can read', async () => {
      // Somebody opened this screen *because* something is wrong. Answering 500
      // when one of four readings is unavailable would be silence at exactly
      // the moment the other three were worth having.
      await writeFile(path.join(stateDir, 'last-backup.json'), '{ this is not json', 'utf8');

      const response = await status(owner.cookies);
      expect(response.statusCode).toBe(200);
      expect(systemStatusResponseSchema.parse(response.json()).lastBackup).toBeNull();
    });
  });

  describe('an installation that has configured nothing', () => {
    it('reports nulls rather than failing', async () => {
      const bare = await buildApp({
        config: {
          ...loadConfig(),
          LOG_LEVEL: 'silent',
          EKON_STATE_DIR: undefined,
          EKON_BACKUP_DIR: undefined,
        },
        pool: db.appPool,
        clock: fixedClock(NOW),
      });

      try {
        const response = await bare.inject({
          method: 'GET',
          url: '/api/system/status',
          cookies: owner.cookies,
        });
        const body = systemStatusResponseSchema.parse(response.json());
        expect(body.lastBackup).toBeNull();
        expect(body.backupDirFreeBytes).toBeNull();
        expect(body.profile).toBe('development');
      } finally {
        await bare.close();
      }
    });
  });
});
