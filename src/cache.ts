import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Writable } from "node:stream";

interface CacheMeta {
  url: string;
  headers: [string, string][];
  ctime: number;
}

/** A cache that stores responses in IndexedDB. */
class Cache {
  private _storeDir: string;
  private _metaDir: string;

  constructor(cacheName = "esm.sh") {
    const home = homedir();

    this._storeDir = join(home, ".cache/" + cacheName);
    this._metaDir = join(this._storeDir, "meta");

    // ensure the cache directory exists
    ensureDir(this._metaDir);
  }

  get storeDir() {
    return this._storeDir;
  }

  getStorePath(url: URL) {
    const savePath = (url.host === "esm.sh" || url.host === "cdn.esm.sh" ? "" : "/-/" + url.host) + url.pathname;
    return join(this._storeDir, savePath);
  }

  async fetch(url: URL): Promise<Response> {
    const cachedRes = this.query(url);
    if (cachedRes) {
      return cachedRes;
    }

    const res = await fetch(url);
    if (!res.ok) {
      return res;
    }

    // check if the response is cacheable
    const cc = res.headers.get("cache-control");
    const maxAge = cc?.match(/max-age=(\d+)/)?.[1];
    if (!maxAge || parseInt(maxAge) < 0) {
      return res;
    }

    // store the redirected response
    if (res.redirected) {
      const urlHref = url.href;
      const urlHash = createHash("sha256").update(urlHref).digest("hex");
      const headers: [string, string][] = [["location", res.url], ["cache-control", cc]];
      const meta: CacheMeta = { url: urlHref, headers, ctime: Date.now() };
      writeFileSync(join(this._metaDir, urlHash + ".json"), JSON.stringify(meta), "utf8");
    }

    const headers = [...res.headers.entries()].filter(([k]) => ["cache-control", "content-type", "x-typescript-types"].includes(k));
    const urlHash = createHash("sha256").update(res.url).digest("hex");
    const meta: CacheMeta = { url: res.url, headers, ctime: Date.now() };
    writeFileSync(join(this._metaDir, urlHash + ".json"), JSON.stringify(meta), "utf8");

    const resUrl = new URL(res.url);
    if (resUrl.pathname.endsWith(".d.ts") || resUrl.pathname.endsWith(".d.mts") || resUrl.pathname.endsWith(".d.cts")) {
      const storePath = this.getStorePath(resUrl);
      ensureDir(dirname(storePath));
      await res.body!.pipeTo(Writable.toWeb(createWriteStream(storePath)));
    } else {
      res.body?.cancel();
    }

    const resp = new Response(null, { headers });
    Object.defineProperty(resp, "url", { value: res.url });
    Object.defineProperty(resp, "redirected", { value: res.redirected });
    return resp;
  }

  query(url: URL): Response | null {
    const urlHash = createHash("sha256").update(url.href).digest("hex");
    const metaPath = join(this._metaDir, urlHash + ".json");
    if (!existsSync(metaPath)) {
      return null;
    }

    let meta: CacheMeta;
    try {
      meta = JSON.parse(readFileSync(metaPath, "utf8")) as CacheMeta;
    } catch {
      rmSync(metaPath);
      return null;
    }

    const headers = new Headers(meta.headers);
    const cc = headers.get("cache-control");
    const maxAge = cc?.match(/max-age=(\d+)/)?.[1];
    if (!maxAge || parseInt(maxAge) < 0 || meta.ctime + parseInt(maxAge) * 1000 < Date.now()) {
      rmSync(metaPath);
      return null;
    }

    if (headers.has("location")) {
      const redirectedUrl = headers.get("location")!;
      const res = this.query(new URL(redirectedUrl));
      if (res) {
        Object.defineProperty(res, "redirected", { value: true });
      }
      return res;
    }

    headers.set("cache-status", "HIT");
    const res = new Response(null, { headers });
    Object.defineProperty(res, "url", { value: meta.url });
    return res;
  }
}

function ensureDir(dir: string) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export const cache = new Cache();
