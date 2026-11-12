/** Reading a request body with a ceiling, so one request cannot hold the process's memory. */

/** The body's bytes, or null when it is larger than `max`. */
export async function readBody(
  request: Request,
  max: number,
): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > max) return null;
  const bytes = new Uint8Array(await request.arrayBuffer());
  return bytes.length > max ? null : bytes;
}

export const tooLarge = () =>
  Response.json({ error: "body too large" }, { status: 413 });
export const notFound = () =>
  Response.json({ error: "not found" }, { status: 404 });
export const notAllowed = () =>
  Response.json({ error: "method not allowed" }, { status: 405 });

/** A SuperPipeline board id. */
export const BOARD_ID = /^brd_[0-9a-f]{16}$/;
/** A SuperPipeline card id. */
export const CARD_ID = /^card_[0-9a-f]{16}$/;
