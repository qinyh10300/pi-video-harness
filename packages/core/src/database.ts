import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type {
  DatabaseSync as NodeDatabaseSync,
  StatementSync,
  SQLInputValue,
} from "node:sqlite";

import { AsyncTransactionError, MigrationError } from "./errors.js";
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from "./migrations.js";

// esbuild versions predating Node's built-in SQLite module incorrectly rewrite
// the static specifier `node:sqlite` to the unrelated third-party package
// `sqlite`. Loading through createRequire preserves the explicit built-in
// protocol in both source execution and bundled dist output.
const nodeSqlite = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");
export const DatabaseSync = nodeSqlite.DatabaseSync;

export interface CoreDatabaseOptions {
  readonly busyTimeoutMs?: number;
  readonly createParentDirectory?: boolean;
}

interface MigrationRow {
  version: number | bigint;
  name: string;
  checksum: string;
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  "then" in value &&
  typeof value.then === "function";

const normalizeFilename = (filename: string): string => {
  if (filename === ":memory:" || filename.startsWith("file:")) {
    return filename;
  }
  return resolve(filename);
};

/**
 * Small synchronous wrapper around Node's built-in SQLite driver.
 *
 * Transactions deliberately reject promises. Holding a SQLite write lock while
 * awaiting a network call would violate the project's persist-before-effect
 * boundary and make crash recovery much harder to reason about.
 */
export class CoreDatabase {
  readonly filename: string;
  readonly sqlite: NodeDatabaseSync;

  #closed = false;
  #transactionDepth = 0;
  #savepointOrdinal = 0;

  constructor(filename: string, options: CoreDatabaseOptions = {}) {
    this.filename = normalizeFilename(filename);

    if (
      options.createParentDirectory !== false &&
      this.filename !== ":memory:" &&
      !this.filename.startsWith("file:")
    ) {
      mkdirSync(dirname(this.filename), { recursive: true });
    }

    const timeout = options.busyTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(timeout) || timeout < 0) {
      throw new RangeError("busyTimeoutMs must be a non-negative safe integer");
    }

    this.sqlite = new DatabaseSync(this.filename);
    this.sqlite.exec(`PRAGMA busy_timeout = ${timeout}`);
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    this.sqlite.exec("PRAGMA journal_mode = WAL");
    this.sqlite.exec("PRAGMA synchronous = NORMAL");
    this.sqlite.exec("PRAGMA temp_store = MEMORY");

    this.#migrate();
  }

  get closed(): boolean {
    return this.#closed;
  }

  get inTransaction(): boolean {
    return this.#transactionDepth > 0;
  }

  get schemaVersion(): number {
    const row = this.queryOne<{ version: number | bigint | null }>(
      "SELECT MAX(version) AS version FROM schema_migrations",
    );
    return Number(row?.version ?? 0);
  }

  prepare(sql: string): StatementSync {
    this.#assertOpen();
    return this.sqlite.prepare(sql);
  }

  exec(sql: string): void {
    this.#assertOpen();
    this.sqlite.exec(sql);
  }

  queryOne<T extends object>(
    sql: string,
    ...parameters: SQLInputValue[]
  ): T | undefined {
    this.#assertOpen();
    return this.sqlite.prepare(sql).get(...parameters) as T | undefined;
  }

  queryAll<T extends object>(sql: string, ...parameters: SQLInputValue[]): T[] {
    this.#assertOpen();
    return this.sqlite.prepare(sql).all(...parameters) as T[];
  }

  run(sql: string, ...parameters: SQLInputValue[]): number {
    this.#assertOpen();
    const result = this.sqlite.prepare(sql).run(...parameters);
    return Number(result.changes);
  }

  transaction<T>(callback: (database: CoreDatabase) => T): T {
    this.#assertOpen();
    const outermost = this.#transactionDepth === 0;
    const savepoint = `core_sp_${++this.#savepointOrdinal}`;

    this.sqlite.exec(outermost ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.#transactionDepth += 1;

    let committed = false;
    try {
      const result = callback(this);
      if (isThenable(result)) {
        throw new AsyncTransactionError();
      }

      this.sqlite.exec(outermost ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
      committed = true;
      return result;
    } catch (error) {
      if (!committed) {
        try {
          this.sqlite.exec(
            outermost
              ? "ROLLBACK"
              : `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`,
          );
        } catch {
          // Preserve the original domain/storage error. A failed rollback means
          // this connection should be closed by the caller.
        }
      }
      throw error;
    } finally {
      this.#transactionDepth -= 1;
    }
  }

  checkpoint(
    mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" = "PASSIVE",
  ): { busy: number; log: number; checkpointed: number } | undefined {
    const row = this.queryOne<{
      busy: number | bigint;
      log: number | bigint;
      checkpointed: number | bigint;
    }>(`PRAGMA wal_checkpoint(${mode})`);
    return row === undefined
      ? undefined
      : {
          busy: Number(row.busy),
          log: Number(row.log),
          checkpointed: Number(row.checkpointed),
        };
  }

  journalMode(): string {
    const row = this.queryOne<Record<string, string>>("PRAGMA journal_mode");
    return row === undefined ? "" : (Object.values(row)[0] ?? "");
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.sqlite.close();
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("CoreDatabase is closed");
    }
  }

  #migrate(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT
    `);

    const applied = this.queryAll<MigrationRow>(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
    );
    const appliedByVersion = new Map(
      applied.map((row) => [Number(row.version), row] as const),
    );

    for (const row of applied) {
      const known = MIGRATIONS.find(
        (candidate) => candidate.version === Number(row.version),
      );
      if (known === undefined) {
        throw new MigrationError(
          `Database schema version ${String(row.version)} is newer than this binary (latest ${LATEST_SCHEMA_VERSION})`,
        );
      }
      if (known.name !== row.name || known.checksum !== row.checksum) {
        throw new MigrationError(
          `Migration ${String(row.version)} does not match the applied checksum`,
        );
      }
    }

    for (const candidate of MIGRATIONS) {
      if (appliedByVersion.has(candidate.version)) {
        continue;
      }

      try {
        this.transaction(() => {
          // Another process may have completed this migration while this
          // connection was waiting for BEGIN IMMEDIATE. Recheck under the
          // write lock before executing DDL.
          const concurrentlyApplied = this.queryOne<MigrationRow>(
            `SELECT version, name, checksum FROM schema_migrations
             WHERE version = ?`,
            candidate.version,
          );
          if (concurrentlyApplied !== undefined) {
            if (
              concurrentlyApplied.name !== candidate.name ||
              concurrentlyApplied.checksum !== candidate.checksum
            ) {
              throw new MigrationError(
                `Migration ${candidate.version} was concurrently applied with a different checksum`,
              );
            }
            return;
          }
          this.sqlite.exec(candidate.sql);
          this.sqlite
            .prepare(
              `INSERT INTO schema_migrations
                 (version, name, checksum, applied_at)
               VALUES (?, ?, ?, ?)`,
            )
            .run(
              candidate.version,
              candidate.name,
              candidate.checksum,
              new Date().toISOString(),
            );
          this.sqlite.exec(`PRAGMA user_version = ${candidate.version}`);
        });
      } catch (error) {
        throw new MigrationError(
          `Failed to apply migration ${candidate.version} (${candidate.name})`,
          { cause: error },
        );
      }
    }

    // A SQLite connection can have this toggled by callers. Reassert it after
    // migrations so every repository operation observes relation constraints.
    this.sqlite.exec("PRAGMA foreign_keys = ON");
  }
}
