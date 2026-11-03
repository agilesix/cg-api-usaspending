/**
 * Finding every award from a set of opportunities, with USAspending's bulk
 * award download.
 *
 * USAspending's search cannot filter on funding opportunity number, so the
 * refresh downloads every grant award with activity since the start date,
 * three columns wide, and keeps the rows whose number matches a stored
 * opportunity. Three properties of the download shape this module:
 *
 * - **It is asynchronous.** A request returns a status URL; the file takes
 *   several minutes to build.
 * - **It is capped at 500,000 rows,** silently. The window is requested in
 *   fiscal-year slices that each stay well under, and a slice that reaches the
 *   cap fails the refresh instead of dropping awards.
 * - **It is large unzipped** (tens of MB), so it is streamed: unzip, split
 *   into lines, parse, and keep only matching rows. It is never held whole.
 */

import { Unzip, UnzipInflate } from "fflate";
import { z } from "zod";

/** The download's row cap (`MAX_DOWNLOAD_LIMIT` in usaspending-api). */
export const DOWNLOAD_ROW_LIMIT = 500_000;

/** Grant award types: block, formula, project, cooperative agreement. */
const AWARD_TYPE_CODES = ["02", "03", "04", "05"];

export const DOWNLOAD_COLUMNS = [
  "assistance_award_unique_key",
  "funding_opportunity_number",
  "last_modified_date",
] as const;

/** The award summaries file inside the zip; it may be split into `_1`, `_2`, ... */
const SUMMARY_FILE = /^Assistance_PrimeAwardSummaries_.*\.csv$/;

export interface DateSlice {
  startDate: string;
  endDate: string;
}

/**
 * Splits `[startDate, endDate]` into US fiscal years (October through
 * September), the unit USAspending reports in.
 */
export function fiscalYearSlices(startDate: string, endDate: string): DateSlice[] {
  const slices: DateSlice[] = [];
  let start = startDate;
  while (start <= endDate) {
    const year = Number(start.slice(0, 4));
    const month = Number(start.slice(5, 7));
    const fyEnd = `${month >= 10 ? year + 1 : year}-09-30`;
    const end = fyEnd < endDate ? fyEnd : endDate;
    slices.push({ startDate: start, endDate: end });
    start = `${Number(fyEnd.slice(0, 4))}-10-01`;
  }
  return slices;
}

export interface DownloadJob {
  slice: DateSlice;
  statusUrl: string;
  fileUrl: string;
}

const RequestResponseSchema = z.object({ status_url: z.string(), file_url: z.string() });

export async function requestDownload(baseUrl: string, slice: DateSlice): Promise<DownloadJob> {
  const response = await fetch(`${baseUrl}/api/v2/download/awards/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      filters: {
        award_type_codes: AWARD_TYPE_CODES,
        // `action_date` on both bounds puts each award in exactly one slice:
        // the one holding its latest action. The default compares the end
        // bound to the signing date instead, and slices then overlap and miss
        // (on Nov 3, 2026: 401,236 + 224,680 for a window of 497,257 awards).
        time_period: [
          { start_date: slice.startDate, end_date: slice.endDate, date_type: "action_date" },
        ],
      },
      columns: DOWNLOAD_COLUMNS,
      file_format: "csv",
    }),
  });
  if (!response.ok) {
    throw new Error(`USAspending download request failed: ${response.status}`);
  }
  const body = RequestResponseSchema.parse(await response.json());
  return { slice, statusUrl: body.status_url, fileUrl: body.file_url };
}

const StatusSchema = z.object({
  status: z.string(),
  total_rows: z.number().nullish(),
  message: z.string().nullish(),
});

export type DownloadStatus =
  | { state: "running" }
  | { state: "finished"; totalRows: number }
  | { state: "failed"; message: string };

export async function checkDownload(job: DownloadJob): Promise<DownloadStatus> {
  const response = await fetch(job.statusUrl, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`USAspending download status failed: ${response.status}`);
  const body = StatusSchema.parse(await response.json());
  if (body.status === "finished") {
    const totalRows = body.total_rows ?? 0;
    if (totalRows >= DOWNLOAD_ROW_LIMIT) {
      return {
        state: "failed",
        message: `Slice ${job.slice.startDate}..${job.slice.endDate} hit USAspending's ${DOWNLOAD_ROW_LIMIT}-row cap`,
      };
    }
    return { state: "finished", totalRows };
  }
  if (body.status === "failed") return { state: "failed", message: body.message ?? "unknown" };
  return { state: "running" };
}

// ############################################################################
// Streaming the file
// ############################################################################

export interface DownloadRow {
  awardKey: string;
  fon: string;
  lastModified: string;
}

/**
 * Splits CSV text into records, across chunk boundaries. Handles quoted fields
 * with embedded commas, quotes ("") and newlines.
 */
export function createCsvParser(onRecord: (fields: string[]) => void) {
  let field = "";
  let fields: string[] = [];
  let quoted = false;
  let pendingQuote = false;

  function endRecord() {
    fields.push(field);
    field = "";
    if (fields.length > 1 || fields[0] !== "") onRecord(fields);
    fields = [];
  }

  return {
    push(text: string) {
      for (let i = 0; i < text.length; i += 1) {
        const c = text[i];
        if (pendingQuote) {
          pendingQuote = false;
          if (c === '"') {
            field += '"';
            continue;
          }
          quoted = false;
        }
        if (quoted) {
          if (c === '"') pendingQuote = true;
          else field += c;
        } else if (c === '"') {
          quoted = true;
        } else if (c === ",") {
          fields.push(field);
          field = "";
        } else if (c === "\n") {
          endRecord();
        } else if (c !== "\r") {
          field += c;
        }
      }
    },
    end() {
      if (pendingQuote) quoted = false;
      if (field !== "" || fields.length > 0) endRecord();
    },
  };
}

/**
 * Streams the zip at `fileUrl` and calls `onRow` for every award row. Returns
 * the number of rows read.
 */
export async function streamDownload(
  fileUrl: string,
  onRow: (row: DownloadRow) => void
): Promise<number> {
  const response = await fetch(fileUrl);
  if (!response.ok || response.body === null) {
    throw new Error(`USAspending download fetch failed: ${response.status}`);
  }

  let rows = 0;
  const pending: Promise<void>[] = [];
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = file => {
    if (!SUMMARY_FILE.test(file.name)) return;
    const decoder = new TextDecoder();
    let columns: Record<string, number> | null = null;
    const parser = createCsvParser(fields => {
      if (columns === null) {
        columns = Object.fromEntries(fields.map((name, i) => [name.trim(), i]));
        for (const name of DOWNLOAD_COLUMNS) {
          if (columns[name] === undefined) throw new Error(`Download is missing column ${name}`);
        }
        return;
      }
      rows += 1;
      onRow({
        awardKey: fields[columns.assistance_award_unique_key ?? 0] ?? "",
        fon: fields[columns.funding_opportunity_number ?? 0] ?? "",
        lastModified: fields[columns.last_modified_date ?? 0] ?? "",
      });
    });
    pending.push(
      new Promise((resolve, reject) => {
        file.ondata = (error, chunk, final) => {
          if (error) return reject(error);
          try {
            parser.push(decoder.decode(chunk, { stream: !final }));
            if (final) {
              parser.end();
              resolve();
            }
          } catch (thrown) {
            reject(thrown instanceof Error ? thrown : new Error(String(thrown)));
          }
        };
      })
    );
    file.start();
  };

  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      unzip.push(new Uint8Array(0), true);
      break;
    }
    unzip.push(value);
  }
  await Promise.all(pending);
  return rows;
}
