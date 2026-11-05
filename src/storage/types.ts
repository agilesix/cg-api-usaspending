/**
 * The parts of the Cloudflare bindings this API uses, typed here rather than
 * pulled from `@cloudflare/workers-types`, as `src/worker.ts` already does for
 * R2. Tests satisfy them with `node:sqlite` and an in-memory map.
 */

export interface D1Result<T> {
  results: T[];
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
  exec(sql: string): Promise<unknown>;
}

export interface R2Object {
  etag: string;
  text(): Promise<string>;
}

export interface R2Bucket {
  get(key: string): Promise<R2Object | null>;
  put(
    key: string,
    value: string,
    options?: { httpMetadata?: { contentType?: string } }
  ): Promise<unknown>;
}
