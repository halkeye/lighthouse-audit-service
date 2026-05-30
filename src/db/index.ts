/*
 * Copyright 2020 Spotify AB
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import knex, { Knex } from 'knex';
import fs from 'fs';
import path from 'path';
import retry, { Options } from 'async-retry';
import { SQLStatement } from 'sql-template-strings';

import logger from '../logger';

export interface DbQueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount: number;
}

export interface DbConnectionType {
  readonly client?: DbClient;
  query<Row = Record<string, unknown>>(
    query: string | SQLStatement,
  ): Promise<DbQueryResult<Row>>;
  end(): Promise<void>;
}

export type DbClient = Knex.Config['client'];
export type DbConfig = Pick<Knex.Config, 'client' | 'connection'>;

function extractQuery(query: string | SQLStatement): {
  text: string;
  values: Knex.RawBinding[];
} {
  if (typeof query === 'string') return { text: query, values: [] };
  return { text: query.sql, values: query.values as Knex.RawBinding[] };
}

function getQueryResultRows<Row>(rawResult: unknown): Row[] {
  if (Array.isArray(rawResult)) {
    const [firstResult] = rawResult;
    if (Array.isArray(firstResult)) return firstResult as Row[];
    if (
      rawResult.length === 0 ||
      typeof firstResult !== 'object' ||
      firstResult === null ||
      !('affectedRows' in firstResult)
    ) {
      return rawResult as Row[];
    }
  }

  if (rawResult && typeof rawResult === 'object' && 'rows' in rawResult) {
    const rows = (rawResult as { rows?: Row[] }).rows;
    return rows || [];
  }

  return [];
}

function getQueryRowCount<Row>(rawResult: unknown, rows: Row[]): number {
  if (
    rawResult &&
    typeof rawResult === 'object' &&
    'rowCount' in rawResult &&
    typeof (rawResult as { rowCount?: unknown }).rowCount === 'number'
  ) {
    return (rawResult as { rowCount: number }).rowCount;
  }
  if (
    rawResult &&
    typeof rawResult === 'object' &&
    'changes' in rawResult &&
    typeof (rawResult as { changes?: unknown }).changes === 'number'
  ) {
    return (rawResult as { changes: number }).changes;
  }
  if (
    Array.isArray(rawResult) &&
    rawResult.length > 0 &&
    rawResult[0] &&
    typeof rawResult[0] === 'object' &&
    'affectedRows' in (rawResult[0] as object) &&
    typeof (rawResult[0] as { affectedRows?: unknown }).affectedRows ===
      'number'
  ) {
    return (rawResult[0] as { affectedRows: number }).affectedRows;
  }
  return rows.length;
}

function normalizeRawQueryResult<Row>(rawResult: unknown): DbQueryResult<Row> {
  const rows = getQueryResultRows<Row>(rawResult);
  const rowCount = getQueryRowCount(rawResult, rows);
  return { rows, rowCount };
}

function getDefaultDbClient(): DbClient {
  return (process.env.LAS_DB_CLIENT as DbClient) || 'pg';
}

function getDefaultConnection(client: DbClient): Knex.Config['connection'] {
  if (client === 'pg' || client === 'postgres' || client === 'postgresql') {
    return {
      host: process.env.PGHOST,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE,
      port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
    };
  }
  if (client === 'mysql' || client === 'mysql2') {
    return {
      host: process.env.MYSQL_HOST,
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE,
      port: process.env.MYSQL_PORT ? Number(process.env.MYSQL_PORT) : undefined,
    };
  }
  if (client === 'sqlite3' || client === 'better-sqlite3') {
    return {
      filename: process.env.SQLITE_FILENAME || ':memory:',
    };
  }
  return undefined;
}

export function createDbConnection(config: DbConfig = {}): DbConnectionType {
  const client = config.client || getDefaultDbClient();
  const db = knex({
    client,
    connection: config.connection || getDefaultConnection(client),
  });

  return {
    client,
    async query<Row = Record<string, unknown>>(
      query: string | SQLStatement,
    ): Promise<DbQueryResult<Row>> {
      const { text, values } = extractQuery(query);
      const rawResult = await db.raw(text, values);
      return normalizeRawQueryResult<Row>(rawResult);
    },
    async end(): Promise<void> {
      await db.destroy();
    },
  };
}

export async function runDbMigrations(conn: DbConnectionType): Promise<void> {
  logger.info('running db migrations...');
  const files = fs.readdirSync(path.join(__dirname, 'migrations')).sort();
  for (const file of files) {
    logger.debug(`running migration "${file}"...`);
    const sql = fs
      .readFileSync(path.join(__dirname, 'migrations', file))
      .toString();
    await conn.query(sql);
  }
}

async function getSchema(conn: DbConnectionType) {
  const sql = 'SELECT 1 as ready';
  const queryResult = await conn.query(sql);
  return queryResult.rows;
}

export async function awaitDbConnection(
  conn: DbConnectionType,
  options: Options = { maxRetryTime: 10000 },
): Promise<void> {
  logger.debug('awaiting db connection...');
  await retry(async () => {
    await Promise.race([
      getSchema(conn),
      new Promise((_res, rej) =>
        setTimeout(() => rej('failed to reach the db in 1000ms'), 1000),
      ),
    ]);
  }, options);
}
