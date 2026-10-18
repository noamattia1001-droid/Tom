import { getStore } from "@netlify/blobs";
import { createHandler } from "../../lib/api.mjs";
import { createBlobsStore } from "../../lib/netlify-store.mjs";

// נוצר בעצלתיים, בבקשה הראשונה, כשסביבת Netlify כבר זמינה
let handler;
const getHandler = () =>
  (handler ??= createHandler(createBlobsStore(getStore({ name: "elections", consistency: "strong" })), {
    adminPassword: process.env.ADMIN_PASSWORD,
  }));

export default (req) => getHandler()(req);
export const config = { path: "/api/*" };
