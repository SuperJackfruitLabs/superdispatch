import { SourceError } from "../sources/index.ts";

/** An error as a log may show it: a source's product, status and code, never a request. */
export function describe(error: unknown): string {
  return error instanceof SourceError
    ? `${error.product} ${error.status} ${error.code}`
    : error instanceof Error
      ? error.name
      : "error";
}
