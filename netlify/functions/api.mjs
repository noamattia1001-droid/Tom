import { getStore } from "@netlify/blobs";
import { createHandler } from "../../lib/api.mjs";

const blobs = getStore({ name: "elections", consistency: "strong" });

const store = {
  get: (k) => blobs.get(k, { type: "json" }),
  set: (k, v) => blobs.setJSON(k, v),
  setIfNew: async (k, v) => (await blobs.setJSON(k, v, { onlyIfNew: true })).modified,
  delete: (k) => blobs.delete(k),
  list: async (prefix) => (await blobs.list({ prefix })).blobs.map((b) => b.key),
};

const handler = createHandler(store, { adminPassword: process.env.ADMIN_PASSWORD });

export default (req) => handler(req);
export const config = { path: "/api/*" };
