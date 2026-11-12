/**
 * The service's HTTP surface. Today only the health check; the event relay's delivery route and
 * the operator's API arrive with the code that answers them.
 */

export const SERVICE = "superdispatch";

export function handle(request: Request): Response {
  const { pathname } = new URL(request.url);
  if (
    pathname === "/healthz" &&
    (request.method === "GET" || request.method === "HEAD")
  ) {
    return Response.json({ ok: true, service: SERVICE });
  }
  return Response.json({ error: "not found" }, { status: 404 });
}
