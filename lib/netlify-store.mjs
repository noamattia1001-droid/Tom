// מתאם בין ה-API (lib/api.mjs) לבין Netlify Blobs.
// כתיבה אטומית: setIfNew מחזיר true רק אם המפתח לא היה קיים (דורש @netlify/blobs 9.2+/10+).

export function createBlobsStore(blobs) {
  return {
    get: (k) => blobs.get(k, { type: "json" }),
    set: async (k, v) => { await blobs.setJSON(k, v); },
    // חשוב: משתמשים ב-set עם מחרוזת ולא ב-setJSON. ב-@netlify/blobs setJSON מתעלם מ-onlyIfNew
    // (לא שולח if-none-match), ואז הכתיבה לא אטומית ואפשר להצביע פעמיים. נבדק ב-scripts/test-blobs.mjs.
    setIfNew: async (k, v) => {
      const res = await blobs.set(k, JSON.stringify(v), { onlyIfNew: true });
      if (!res || typeof res.modified !== "boolean") {
        throw new Error("@netlify/blobs does not support onlyIfNew - upgrade the package");
      }
      return res.modified;
    },
    delete: (k) => blobs.delete(k),
    list: async (prefix) => (await blobs.list({ prefix })).blobs.map((b) => b.key),
  };
}
