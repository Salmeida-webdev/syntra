import * as api from "./api-handler";

type ApiMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
    const method = request.method.toUpperCase() as ApiMethod;
    const handler = method === "DELETE"
      ? undefined
      : api[method as Exclude<ApiMethod, "DELETE">];
    if (!handler) return Response.json({ error: "Método não permitido." }, { status: 405 });
    return handler(request, { params: Promise.resolve({ path }) });
  },
};
