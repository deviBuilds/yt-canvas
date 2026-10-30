// yt-canvas accounts. Only the yt-canvas server reads and writes these tables, through the
// /backend HTTP action (http.ts); the browser never talks to Convex.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // One per Clerk user who has signed in and is on the allowlist.
  users: defineTable({
    clerkId: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    // Add-on apps this person turned on (e.g. "plex").
    apps: v.array(v.string()),
    createdAt: v.number(),
  })
    .index("by_clerk", ["clerkId"])
    .index("by_email", ["email"]),

  // Who may sign in, by lowercased email.
  allowlist: defineTable({
    email: v.string(),
    addedBy: v.optional(v.string()),
    addedAt: v.number(),
  }).index("by_email", ["email"]),

  // A user's secrets ("plex", "youtube_cookies"), encrypted by the yt-canvas server with a key
  // Convex never sees. `meta` holds only harmless facts, such as when cookies were uploaded.
  secrets: defineTable({
    userId: v.id("users"),
    kind: v.string(),
    ciphertext: v.string(),
    meta: v.any(),
    updatedAt: v.number(),
  }).index("by_user_kind", ["userId", "kind"]),

  // Paired devices (a car, a TV): the SHA-256 of each device's cookie, never the cookie.
  devices: defineTable({
    userId: v.id("users"),
    name: v.string(),
    tokenHash: v.string(),
    createdAt: v.number(),
    lastSeen: v.number(),
  })
    .index("by_hash", ["tokenHash"])
    .index("by_user", ["userId"]),

  // Favorites, history (with positions, for continue watching) and recent searches. `data` is
  // the entry exactly as the frontend keeps it; `key` identifies it within its list.
  library: defineTable({
    userId: v.id("users"),
    list: v.string(),
    key: v.string(),
    data: v.any(),
    updatedAt: v.number(),
  })
    .index("by_user_list_key", ["userId", "list", "key"])
    .index("by_user_list_updated", ["userId", "list", "updatedAt"]),
});
