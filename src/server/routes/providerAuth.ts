import { Hono } from "hono";
import { json, type Env } from "../http.js";
import {
  authProviders,
  startLogin,
  loginStatus,
  answerLogin,
  cancelLogin,
  logoutProvider,
} from "../providerAuth.js";

export function providerAuthRoutes() {
  return new Hono<Env>()
    .get("/auth/providers", async (c) =>
      c.json({ providers: await authProviders() }, 200),
    )
    .post(
      "/auth/login",
      json<{ provider: string; type: "oauth" | "api_key" }>(),
      async (c) => {
        const b = c.req.valid("json");
        if (
          typeof b.provider !== "string" ||
          !["oauth", "api_key"].includes(b.type)
        )
          return c.json({ error: "Invalid login request" }, 400);
        return c.json({ login: await startLogin(b.provider, b.type) }, 200);
      },
    )
    .get("/auth/login/:id", (c) =>
      c.json({ login: loginStatus(c.req.param("id")) }, 200),
    )
    .post("/auth/login/:id", json<{ prompt: string; value: string }>(), (c) => {
      const b = c.req.valid("json");
      if (
        typeof b.prompt !== "string" ||
        typeof b.value !== "string" ||
        !b.value.trim() ||
        b.value.length > 16_384
      )
        return c.json({ error: "Enter a response" }, 400);
      return c.json(
        { login: answerLogin(c.req.param("id"), b.prompt, b.value) },
        200,
      );
    })
    .delete("/auth/login/:id", (c) => {
      cancelLogin(c.req.param("id"));
      return c.json({ ok: true }, 200);
    })
    .post("/auth/logout", json<{ provider: string }>(), async (c) => {
      const b = c.req.valid("json");
      if (typeof b.provider !== "string")
        return c.json({ error: "Invalid provider" }, 400);
      await logoutProvider(b.provider);
      return c.json({ ok: true }, 200);
    });
}
