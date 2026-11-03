/**
 * Test doubles for the Cloudflare bindings: a D1 database over `node:sqlite`
 * (D1 is SQLite), and an R2 bucket over a Map.
 */

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { D1Database, D1PreparedStatement, R2Bucket } from "../src/storage/types.js";
import { readFileSync } from "node:fs";

/** The schema, as `wrangler d1 migrations apply` would apply it. */
const SCHEMA = readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8");

class Statement implements D1PreparedStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly values: unknown[] = []
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    // D1's limit; node:sqlite would accept far more.
    if (values.length > 100) {
      throw new Error(`D1 allows at most 100 bound parameters, got ${values.length}`);
    }
    return new Statement(this.db, this.sql, values);
  }

  private params(): SQLInputValue[] {
    return this.values as SQLInputValue[];
  }

  async all<T>() {
    return { results: this.db.prepare(this.sql).all(...this.params()) as T[] };
  }

  async first<T>() {
    return (this.db.prepare(this.sql).get(...this.params()) as T | undefined) ?? null;
  }

  async run() {
    return this.db.prepare(this.sql).run(...this.params());
  }
}

/** A fresh in-memory D1 database, with the schema applied unless `empty`. */
export function createTestD1({ empty = false } = {}): D1Database & { sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  if (!empty) sqlite.exec(SCHEMA);
  return {
    sqlite,
    prepare: sql => new Statement(sqlite, sql),
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results: unknown[] = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    async exec(sql) {
      sqlite.exec(sql);
      return {};
    },
  };
}

export function createTestBucket(): R2Bucket & { objects: Map<string, string> } {
  const objects = new Map<string, string>();
  return {
    objects,
    async get(key) {
      const value = objects.get(key);
      return value === undefined ? null : { etag: String(value.length), text: async () => value };
    },
    async put(key, value) {
      objects.set(key, value);
      return {};
    },
  };
}
