// HTTP entry points:
// - POST /backend: the yt-canvas server, with `Authorization: Bearer <YTC_CONVEX_SECRET>`, runs one
//   of the internal functions in backend.ts by name.
// - POST /clerk-webhook: Clerk's user events, verified with svix (CLERK_WEBHOOK_SECRET). Sign-ups by
//   people who aren't on the allowlist are deleted from Clerk (CLERK_SECRET_KEY); deleted Clerk
//   accounts take their data with them.
import { httpRouter, type FunctionReference } from "convex/server";
import { Webhook } from "svix";

import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

type Op = ["query" | "mutation", FunctionReference<"query" | "mutation", "internal">];

const OPS: Record<string, Op> = {
  "users.resolve": ["mutation", internal.backend.resolveUser],
  "users.setApps": ["mutation", internal.backend.setApps],
  "secrets.get": ["query", internal.backend.getSecret],
  "secrets.put": ["mutation", internal.backend.putSecret],
  "secrets.delete": ["mutation", internal.backend.deleteSecret],
  "devices.create": ["mutation", internal.backend.createDevice],
  "devices.byHash": ["query", internal.backend.deviceByHash],
  "devices.touch": ["mutation", internal.backend.touchDevice],
  "devices.list": ["query", internal.backend.listDevices],
  "devices.revoke": ["mutation", internal.backend.revokeDevice],
  "library.get": ["query", internal.backend.library],
  "library.put": ["mutation", internal.backend.libraryPut],
  "library.remove": ["mutation", internal.backend.libraryRemove],
  "library.clear": ["mutation", internal.backend.libraryClear],
  "allowlist.list": ["query", internal.backend.allowlistList],
  "allowlist.add": ["mutation", internal.backend.allowlistAdd],
  "allowlist.remove": ["mutation", internal.backend.allowlistRemove],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Constant-time string comparison, so the secret can't be guessed byte by byte. */
function sameSecret(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

const http = httpRouter();

http.route({
  path: "/backend",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const expected = process.env.YTC_CONVEX_SECRET;
    const given = (request.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
    if (!expected || !sameSecret(given, expected)) return json({ error: "unauthorized" }, 401);
    let body: { op?: string; args?: Record<string, unknown> };
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad_request" }, 400);
    }
    const op = body.op ? OPS[body.op] : undefined;
    if (!op) return json({ error: "unknown_op" }, 404);
    const [kind, ref] = op;
    try {
      const result =
        kind === "query"
          ? await ctx.runQuery(ref as FunctionReference<"query", "internal">, body.args ?? {})
          : await ctx.runMutation(ref as FunctionReference<"mutation", "internal">, body.args ?? {});
      return json({ result: result ?? null });
    } catch (err) {
      // Argument validation errors and the like; the message never holds secrets.
      return json({ error: "failed", message: err instanceof Error ? err.message : String(err) }, 400);
    }
  }),
});

interface ClerkEmail {
  id: string;
  email_address: string;
}

interface ClerkUser {
  id: string;
  primary_email_address_id: string | null;
  email_addresses?: ClerkEmail[];
  first_name?: string | null;
  last_name?: string | null;
  image_url?: string | null;
}

function primaryEmail(user: ClerkUser): string | null {
  const emails = user.email_addresses ?? [];
  return (emails.find((e) => e.id === user.primary_email_address_id) ?? emails[0])?.email_address ?? null;
}

function fullName(user: ClerkUser): string | undefined {
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || undefined;
}

http.route({
  path: "/clerk-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.CLERK_WEBHOOK_SECRET;
    if (!secret) return json({ error: "not_configured" }, 500);
    const payload = await request.text();
    try {
      new Webhook(secret).verify(payload, {
        "svix-id": request.headers.get("svix-id") ?? "",
        "svix-timestamp": request.headers.get("svix-timestamp") ?? "",
        "svix-signature": request.headers.get("svix-signature") ?? "",
      });
    } catch {
      return json({ error: "bad_signature" }, 400);
    }
    const event = JSON.parse(payload) as { type: string; data: ClerkUser };
    const user = event.data;
    if (event.type === "user.deleted") {
      await ctx.runMutation(internal.backend.deleteUserByClerkId, { clerkId: user.id });
    } else if (event.type === "user.created" || event.type === "user.updated") {
      const email = primaryEmail(user);
      const ok = email !== null && (await ctx.runQuery(internal.backend.isAllowed, { email }));
      if (!ok && event.type === "user.created") {
        // Allowlist-only sign-ups: remove the account Clerk just made.
        const key = process.env.CLERK_SECRET_KEY;
        if (key) {
          await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(user.id)}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${key}` },
          });
        }
      } else if (email !== null) {
        await ctx.runMutation(internal.backend.updateProfile, {
          clerkId: user.id,
          email,
          name: fullName(user),
          imageUrl: user.image_url ?? undefined,
        });
      }
    }
    return json({ ok: true });
  }),
});

export default http;
