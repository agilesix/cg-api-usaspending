/**
 * Runs one refresh from Node and writes the snapshot to a file.
 *
 *   pnpm refresh                     writes src/data/snapshot.json
 *   pnpm refresh path/to/out.json    writes somewhere else
 *
 * Reads settings from the environment (see `src/pipeline/config.ts`).
 * `SGG_API_KEY` is required. This builds the small sample bundled with the
 * code. The deployed Worker refreshes its database separately, through the
 * Workflow in `src/sync/workflow.ts`.
 */

import fs from "node:fs/promises";
import { loadConfig } from "../src/pipeline/config.js";
import { runRefresh } from "../src/pipeline/run.js";

const DEFAULT_OUT = "src/data/snapshot.json";

const out = process.argv[2] ?? DEFAULT_OUT;
const config = loadConfig(process.env);
const snapshot = await runRefresh(config, { log: message => console.log(message) });

await fs.writeFile(out, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
console.log(`Wrote ${out} (data as of ${snapshot.asOf})`);
