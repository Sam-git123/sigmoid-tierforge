import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { runMigrations } from '../../src/db/migrate.js';

export async function createTestDatabase(connectionString: string) {
  const schema = `tierforge_upload_test_${randomUUID().replaceAll('-', '')}`;
  if (!/^tierforge_upload_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Invalid test schema');
  const admin = new pg.Pool({ connectionString, connectionTimeoutMillis: 3000 });
  let pool: pg.Pool | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({
      connectionString,
      options: `-c search_path=${schema}`,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
    });
    await runMigrations(pool);
    const databasePool = pool;
    return {
      pool: databasePool,
      async reset() {
        // search_path is this generated schema; application/public tables are never cleared.
        await databasePool.query(
          'TRUNCATE jobs, job_stores, store_enrichments, scoring_configs, store_scores',
        );
      },
      async close() {
        await databasePool.end();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      },
    };
  } catch (error) {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
    throw error;
  }
}
