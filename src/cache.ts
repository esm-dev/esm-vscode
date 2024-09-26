import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Writable } from "node:stream";

interface CacheMeta {
  url: string;
  code: number;
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
    const cachedResponse = await this.query(url);
    if (cachedResponse) {
      return cachedResponse;
    }
    const res = await fetch(url, { redirect: "manual" });
    const urlHash = createHash("sha256").update(url.href).digest("hex");
    if (res.status === 302 || res.status === 301) {
      const meta: CacheMeta = { url: url.href, code: res.status, headers: [["location", res.url]], ctime: Date.now() };
      writeFileSync(join(this._metaDir, urlHash + ".json"), JSON.stringify(meta), "utf8");
      return res;
    }
    if (!res.ok) {
      return res;
    }
    const cc = res.headers.get("cache-control");
    const maxAge = cc?.match(/max-age=(\d+)/)?.[1];
    if (!maxAge || parseInt(maxAge) < 0) {
      return res;
    }
    const headers = [...res.headers.entries()].filter(([k]) => ["cache-control", "content-type", "x-typescript-types"].includes(k));
    const meta: CacheMeta = { url: res.url, code: 200, headers, ctime: Date.now() };
    writeFileSync(join(this._metaDir, urlHash + ".json"), JSON.stringify(meta), "utf8");
    if (url.pathname.endsWith(".d.ts") || url.pathname.endsWith(".d.mts") || url.pathname.endsWith(".d.cts")) {
      const storePath = this.getStorePath(url);
      ensureDir(dirname(storePath));
      await res.body!.pipeTo(Writable.toWeb(createWriteStream(storePath)));
    } else {
      res.body?.cancel();
    }
    const resp = new Response(null, { headers });
    Object.defineProperty(resp, "url", { value: res.url });
    return resp;
  }

  async query(url: URL): Promise<Response | null> {
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
    if (headers.get("location")) {
      const res = new Response(null, { status: meta.code, headers });
      Object.defineProperty(res, "url", { value: meta.url });
      Object.defineProperty(res, "redirected", { value: true });
      return res;
    }
    const cc = headers.get("cache-control");
    const maxAge = cc?.match(/max-age=(\d+)/)?.[1];
    if (!maxAge || parseInt(maxAge) < 0 || meta.ctime + parseInt(maxAge) * 1000 < Date.now()) {
      rmSync(metaPath);
      return null;
    }
    const res = new Response(null, { headers });
    Object.defineProperty(res, "url", { value: meta.url });
    return res;
  }

  head(url: URL): Response | null {
    const urlHash = createHash("sha256").update(url.href).digest("hex");
    const metaPath = join(this._metaDir, urlHash + ".json");
    if (!existsSync(metaPath)) {
      return null;
    }
    let meta: CacheMeta;
    try {
      meta = JSON.parse(readFileSync(metaPath, "utf8")) as CacheMeta;
      return new Response(null, { status: meta.code, headers: meta.headers });
    } catch {
      rmSync(metaPath);
      return null;
    }
  }
}

function ensureDir(dir: string) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export const cache = new Cache();
