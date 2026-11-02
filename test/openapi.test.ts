import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { stubRepository } from "./support.js";

interface Operation {
  responses: Record<string, { content?: Record<string, { schema?: unknown }> }>;
}
interface Document {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, Operation>>;
}

const OPERATIONS: [path: string, method: string, statuses: string[]][] = [
  ["/health", "get", ["200"]],
  ["/common-grants/opportunities", "get", ["200", "400", "500"]],
  ["/common-grants/opportunities/{oppId}", "get", ["200", "400", "404", "500"]],
  ["/common-grants/opportunities/search", "post", ["200", "400", "500"]],
];

let document: Document;

beforeAll(async () => {
  const app = createApp(stubRepository());
  document = (await (await app.request("/openapi.json")).json()) as Document;
});

describe("the served OpenAPI document", () => {
  it("is OpenAPI 3.1", () => {
    expect(document.openapi).toBe("3.1.0");
    expect(document.info.title).toBeTruthy();
    expect(document.info.version).toBeTruthy();
  });

  it("documents every route the application registers and nothing else", () => {
    const documented = Object.entries(document.paths)
      .flatMap(([path, ops]) => Object.keys(ops).map(method => `${method} ${path}`))
      .sort();
    const expected = OPERATIONS.map(([path, method]) => `${method} ${path}`).sort();
    expect(documented).toEqual(expected);
  });

  it.each(OPERATIONS)(
    "gives %s %s a JSON schema for each declared status",
    (path, method, statuses) => {
      const operation = document.paths[path]?.[method];
      expect(operation, `${method} ${path} is missing`).toBeDefined();
      expect(Object.keys(operation!.responses).sort()).toEqual([...statuses].sort());

      for (const status of statuses) {
        const schema = operation!.responses[status]?.content?.["application/json"]?.schema;
        expect(schema, `${method} ${path} ${status} has no JSON schema`).toBeTypeOf("object");
        // A bare `{}` would satisfy "has a schema" while documenting nothing.
        expect(Object.keys(schema as object).length).toBeGreaterThan(0);
      }
    }
  );

  it("describes the opportunity payload rather than an opaque object", () => {
    const schema = document.paths["/common-grants/opportunities"]?.["get"]?.responses["200"]
      ?.content?.["application/json"]?.schema as {
      properties: { items: { items: { properties: Record<string, unknown>; required: string[] } } };
    };
    const item = schema.properties.items.items;
    expect(item.required).toEqual(
      expect.arrayContaining([
        "id",
        "title",
        "status",
        "description",
        "createdAt",
        "lastModifiedAt",
      ])
    );
    expect(item.properties["id"]).toMatchObject({ type: "string", format: "uuid" });
    expect(item.properties["lastModifiedAt"]).toMatchObject({
      type: "string",
      format: "date-time",
    });
  });
});
