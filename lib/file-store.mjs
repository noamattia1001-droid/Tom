// אחסון מקומי בקובץ JSON - לפיתוח ובדיקות בלבד (בענן משתמשים ב-Netlify Blobs)
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export function createFileStore(file = ".data/store.json") {
  let data = null;
  let chain = Promise.resolve();
  const load = async () => {
    if (data) return data;
    try { data = JSON.parse(await readFile(file, "utf8")); } catch { data = {}; }
    return data;
  };
  const save = async () => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(data));
  };
  const serial = (fn) => (chain = chain.then(fn, fn));
  return {
    get: (k) => serial(async () => ((await load())[k] ?? null)),
    set: (k, v) => serial(async () => { (await load())[k] = v; await save(); }),
    setIfNew: (k, v) => serial(async () => {
      const d = await load();
      if (k in d) return false;
      d[k] = v; await save(); return true;
    }),
    delete: (k) => serial(async () => { delete (await load())[k]; await save(); }),
    list: (prefix) => serial(async () => Object.keys(await load()).filter((k) => k.startsWith(prefix))),
  };
}
