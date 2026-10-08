import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const defaultDirectory = fileURLToPath(new URL('../../migrations/', import.meta.url));

// One session owns both the advisory lock and each migration transaction.
// The database-wide lock also serializes concurrent CLI invocations.
export async function runMigrations(pool: Pool, directory = defaultDirectory): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  let locked = false;
  let destroy = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('tierforge:migrations'))");
    locked = true;
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const names = (await readdir(directory))
      .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/.test(name))
      .sort();
    const existing = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations ORDER BY name',
    );
    const known = new Map(existing.rows.map((row) => [row.name, row.checksum]));
    for (const name of known.keys()) {
      if (!names.includes(name)) throw new Error(`Applied migration is missing: ${name}`);
    }
    for (const name of names) {
      const sql = await readFile(join(directory, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      if (known.has(name)) {
        if (known.get(name) !== checksum) throw new Error(`Applied migration has changed: ${name}`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
          name,
          checksum,
        ]);
        await client.query('COMMIT');
        applied.push(name);
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          destroy = true;
        }
        throw error;
      }
    }
    return applied;
  } finally {
    if (locked && !destroy) {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtext('tierforge:migrations'))");
      } catch {
        destroy = true;
      }
    }
    client.release(destroy);
  }
}
