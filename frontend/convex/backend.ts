// Server-only functions. They are internal, so no client can call them; the yt-canvas server
// reaches them through the /backend HTTP action (http.ts), which checks a shared secret and
// passes the signed-in person's user id. Secrets arrive already encrypted.
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";

const list = v.union(v.literal("favorites"), v.literal("history"), v.literal("searches"));
const LIMITS = { favorites: 200, history: 100, searches: 12 } as const;

const normalize = (email: string) => email.trim().toLowerCase();

async function allowed(ctx: QueryCtx, email: string): Promise<boolean> {
  const entry = await ctx.db
    .query("allowlist")
    .withIndex("by_email", (q) => q.eq("email", normalize(email)))
    .unique();
  return entry !== null;
}

async function userView(ctx: QueryCtx, user: Doc<"users">) {
  const secrets = await ctx.db
    .query("secrets")
    .withIndex("by_user_kind", (q) => q.eq("userId", user._id))
    .collect();
  return {
    id: user._id,
    clerkId: user.clerkId,
    email: user.email,
    name: user.name ?? null,
    imageUrl: user.imageUrl ?? null,
    apps: user.apps,
    // Which secrets exist, with their harmless metadata; never the ciphertext here.
    secrets: Object.fromEntries(secrets.map((s) => [s.kind, { meta: s.meta, updatedAt: s.updatedAt }])),
  };
}

function deviceView(device: Doc<"devices">) {
  return { id: device._id, name: device.name, created: device.createdAt / 1000, last_seen: device.lastSeen / 1000 };
}

// -- users ---------------------------------------------------------------------------------

/** A Clerk user signing in: create or refresh their record when they're allowed. */
export const resolveUser = internalMutation({
  args: {
    clerkId: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    admin: v.boolean(),
  },
  handler: async (ctx, args) => {
    const email = normalize(args.email);
    if (!args.admin && !(await allowed(ctx, email))) return { allowed: false, user: null };
    let user = await ctx.db
      .query("users")
      .withIndex("by_clerk", (q) => q.eq("clerkId", args.clerkId))
      .unique();
    if (user === null) {
      const id = await ctx.db.insert("users", {
        clerkId: args.clerkId,
        email,
        name: args.name,
        imageUrl: args.imageUrl,
        apps: [],
        createdAt: Date.now(),
      });
      user = (await ctx.db.get(id))!;
    } else if (user.email !== email || user.name !== args.name || user.imageUrl !== args.imageUrl) {
      await ctx.db.patch(user._id, { email, name: args.name, imageUrl: args.imageUrl });
      user = (await ctx.db.get(user._id))!;
    }
    return { allowed: true, user: await userView(ctx, user) };
  },
});

export const setApps = internalMutation({
  args: { userId: v.id("users"), apps: v.array(v.string()) },
  handler: async (ctx, { userId, apps }) => {
    await ctx.db.patch(userId, { apps });
    return null;
  },
});

async function deleteUser(ctx: MutationCtx, userId: Id<"users">) {
  const rows = [
    ...(await ctx.db
      .query("secrets")
      .withIndex("by_user_kind", (q) => q.eq("userId", userId))
      .collect()),
    ...(await ctx.db
      .query("devices")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect()),
    ...(await ctx.db
      .query("library")
      .withIndex("by_user_list_key", (q) => q.eq("userId", userId))
      .collect()),
  ];
  for (const row of rows) await ctx.db.delete(row._id);
  await ctx.db.delete(userId);
}

/** The Clerk account is gone (the webhook): delete everything that was theirs. */
export const deleteUserByClerkId = internalMutation({
  args: { clerkId: v.string() },
  handler: async (ctx, { clerkId }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk", (q) => q.eq("clerkId", clerkId))
      .unique();
    if (user !== null) await deleteUser(ctx, user._id);
    return user !== null;
  },
});

/** Clerk changed someone's profile (the webhook): keep the stored email and name current. */
export const updateProfile = internalMutation({
  args: { clerkId: v.string(), email: v.string(), name: v.optional(v.string()), imageUrl: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk", (q) => q.eq("clerkId", args.clerkId))
      .unique();
    if (user !== null) {
      await ctx.db.patch(user._id, { email: normalize(args.email), name: args.name, imageUrl: args.imageUrl });
    }
    return null;
  },
});

// -- secrets (ciphertext only) ---------------------------------------------------------------

export const getSecret = internalQuery({
  args: { userId: v.id("users"), kind: v.string() },
  handler: async (ctx, { userId, kind }) => {
    const secret = await ctx.db
      .query("secrets")
      .withIndex("by_user_kind", (q) => q.eq("userId", userId).eq("kind", kind))
      .unique();
    return secret && { ciphertext: secret.ciphertext, meta: secret.meta, updatedAt: secret.updatedAt };
  },
});

// Everyone's secrets of one kind, without their ciphertext: the server's background renewal
// reads the meta to see whose cookies are due. A table scan, fine for a personal allowlist.
export const secretsOfKind = internalQuery({
  args: { kind: v.string() },
  handler: async (ctx, { kind }) => {
    const secrets = await ctx.db.query("secrets").collect();
    return secrets
      .filter((s) => s.kind === kind)
      .map((s) => ({ userId: s.userId, meta: s.meta, updatedAt: s.updatedAt }));
  },
});

export const putSecret = internalMutation({
  args: { userId: v.id("users"), kind: v.string(), ciphertext: v.string(), meta: v.any() },
  handler: async (ctx, { userId, kind, ciphertext, meta }) => {
    const existing = await ctx.db
      .query("secrets")
      .withIndex("by_user_kind", (q) => q.eq("userId", userId).eq("kind", kind))
      .unique();
    const fields = { ciphertext, meta, updatedAt: Date.now() };
    if (existing === null) await ctx.db.insert("secrets", { userId, kind, ...fields });
    else await ctx.db.patch(existing._id, fields);
    return fields.updatedAt;
  },
});

export const deleteSecret = internalMutation({
  args: { userId: v.id("users"), kind: v.string() },
  handler: async (ctx, { userId, kind }) => {
    const existing = await ctx.db
      .query("secrets")
      .withIndex("by_user_kind", (q) => q.eq("userId", userId).eq("kind", kind))
      .unique();
    if (existing !== null) await ctx.db.delete(existing._id);
    return existing !== null;
  },
});

// -- devices ---------------------------------------------------------------------------------

export const createDevice = internalMutation({
  args: { userId: v.id("users"), name: v.string(), tokenHash: v.string() },
  handler: async (ctx, { userId, name, tokenHash }) => {
    const now = Date.now();
    const id = await ctx.db.insert("devices", { userId, name, tokenHash, createdAt: now, lastSeen: now });
    return deviceView((await ctx.db.get(id))!);
  },
});

/** A device's cookie, hashed: the device, its owner, and whether the owner may still sign in. */
export const deviceByHash = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const device = await ctx.db
      .query("devices")
      .withIndex("by_hash", (q) => q.eq("tokenHash", tokenHash))
      .unique();
    if (device === null) return null;
    const user = await ctx.db.get(device.userId);
    if (user === null) return null;
    return { device: deviceView(device), user: await userView(ctx, user), allowed: await allowed(ctx, user.email) };
  },
});

export const touchDevice = internalMutation({
  args: { deviceId: v.id("devices") },
  handler: async (ctx, { deviceId }) => {
    if (await ctx.db.get(deviceId)) await ctx.db.patch(deviceId, { lastSeen: Date.now() });
    return null;
  },
});

export const listDevices = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const devices = await ctx.db
      .query("devices")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return devices.map(deviceView);
  },
});

export const revokeDevice = internalMutation({
  args: { userId: v.id("users"), deviceId: v.string() },
  handler: async (ctx, { userId, deviceId }) => {
    const id = ctx.db.normalizeId("devices", deviceId);
    const device = id && (await ctx.db.get(id));
    if (!device || device.userId !== userId) return null;
    await ctx.db.delete(device._id);
    return device.tokenHash;
  },
});

// -- library: favorites, history, searches --------------------------------------------------

export const library = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const read = async (name: keyof typeof LIMITS) => {
      const rows = await ctx.db
        .query("library")
        .withIndex("by_user_list_updated", (q) => q.eq("userId", userId).eq("list", name))
        .order("desc")
        .take(LIMITS[name]);
      return rows.map((row) => row.data);
    };
    return { favorites: await read("favorites"), history: await read("history"), searches: await read("searches") };
  },
});

/** Add or replace entries (newest wins per key), then trim the list to its limit. */
export const libraryPut = internalMutation({
  args: {
    userId: v.id("users"),
    list,
    entries: v.array(v.object({ key: v.string(), data: v.any(), updatedAt: v.number() })),
  },
  handler: async (ctx, { userId, list: name, entries }) => {
    for (const entry of entries) {
      const existing = await ctx.db
        .query("library")
        .withIndex("by_user_list_key", (q) => q.eq("userId", userId).eq("list", name).eq("key", entry.key))
        .unique();
      if (existing === null) await ctx.db.insert("library", { userId, list: name, ...entry });
      else if (existing.updatedAt <= entry.updatedAt) await ctx.db.patch(existing._id, entry);
    }
    const rows = await ctx.db
      .query("library")
      .withIndex("by_user_list_updated", (q) => q.eq("userId", userId).eq("list", name))
      .order("desc")
      .collect();
    for (const row of rows.slice(LIMITS[name])) await ctx.db.delete(row._id);
    return null;
  },
});

export const libraryRemove = internalMutation({
  args: { userId: v.id("users"), list, key: v.string() },
  handler: async (ctx, { userId, list: name, key }) => {
    const existing = await ctx.db
      .query("library")
      .withIndex("by_user_list_key", (q) => q.eq("userId", userId).eq("list", name).eq("key", key))
      .unique();
    if (existing !== null) await ctx.db.delete(existing._id);
    return null;
  },
});

export const libraryClear = internalMutation({
  args: { userId: v.id("users"), list },
  handler: async (ctx, { userId, list: name }) => {
    const rows = await ctx.db
      .query("library")
      .withIndex("by_user_list_key", (q) => q.eq("userId", userId).eq("list", name))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
    return null;
  },
});

// -- allowlist -------------------------------------------------------------------------------

export const allowlistList = internalQuery({
  args: {},
  handler: async (ctx) => {
    const entries = await ctx.db.query("allowlist").collect();
    return entries
      .map((e) => ({ email: e.email, addedBy: e.addedBy ?? null, addedAt: e.addedAt / 1000 }))
      .sort((a, b) => a.email.localeCompare(b.email));
  },
});

export const isAllowed = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, { email }) => allowed(ctx, email),
});

export const allowlistAdd = internalMutation({
  args: { emails: v.array(v.string()), addedBy: v.optional(v.string()) },
  handler: async (ctx, { emails, addedBy }) => {
    let added = 0;
    for (const raw of emails) {
      const email = normalize(raw);
      if (!email || (await allowed(ctx, email))) continue;
      await ctx.db.insert("allowlist", { email, addedBy, addedAt: Date.now() });
      added += 1;
    }
    return added;
  },
});

export const allowlistRemove = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const entry = await ctx.db
      .query("allowlist")
      .withIndex("by_email", (q) => q.eq("email", normalize(email)))
      .unique();
    if (entry !== null) await ctx.db.delete(entry._id);
    return entry !== null;
  },
});
