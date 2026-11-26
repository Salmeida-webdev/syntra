import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ path: string[] }> };

async function forward(request: NextRequest, context: RouteContext) {
  const base = process.env.SYNTRA_API_URL;
  if (!base) {
    return Response.json({ error: "A URL da API Syntra não está configurada." }, { status: 503 });
  }

  let target: URL;
  try {
    target = new URL(base);
  } catch {
    return Response.json({ error: "A URL da API Syntra está inválida." }, { status: 503 });
  }

  const { path = [] } = await context.params;
  const suffix = path.map((part) => encodeURIComponent(part)).join("/");
  target.pathname = `/api/${suffix}`;
  target.search = new URL(request.url).search;

  const headers = new Headers(request.headers);
  for (const header of ["host", "connection", "content-length", "transfer-encoding"]) {
    headers.delete(header);
  }

  const method = request.method.toUpperCase();
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers,
    cache: "no-store",
    redirect: "manual",
  };
  if (method !== "GET" && method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }

  try {
    const upstream = await fetch(target, init);
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
    responseHeaders.delete("transfer-encoding");

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch {
    return Response.json({ error: "Não foi possível conectar à API Syntra." }, { status: 502 });
  }
}

export const GET = forward;
export const POST = forward;
export const PATCH = forward;
export const PUT = forward;
