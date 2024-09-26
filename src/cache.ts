import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";

interface CacheMeta {
  url: string;
  code: number;
  headers: [string, string][];
  ctime: number;
}

/** A cache that stores responses in IndexedDB. */
class Cache {
  private _cacheRootDir: string;
  private _metaDir: string;

  constructor(cacheName = "esm.sh") {
    const home = homedir();

    this._cacheRootDir = join(home, ".cache/" + cacheName);
    this._metaDir = join(this._cacheRootDir, "meta");

    // ensure the cache directory exists
    ensureDir(this._metaDir);
  }

  get storeDir() {
    return this._cacheRootDir;
  }

  async fetch(url: URL): Promise<Response> {
    const cachedResponse = await this.query(url);
    if (cachedResponse) {
      return cachedResponse;
    }
    const res = await fetch(url);
    const urlHash = createHash("sha256").update(url.href).digest("hex");
    if (res.status === 302 || res.status === 301) {
      const meta: CacheMeta = { url: url.href, code: res.status, headers: [["location", res.url]], ctime: Date.now() };
      writeFileSync(join(this._metaDir, urlHash + ".json"), JSON.stringify(meta), "utf8");
      return res;
    }
    if (!res.ok || !res.body) {
      return res;
    }
    const cc = res.headers.get("cache-control");
    const maxAge = cc?.match(/max-age=(\d+)/)?.[1];
    if (!maxAge || parseInt(maxAge) < 0) {
      return res;
    }
    const headers = [...res.headers.entries()].filter(([k]) => ["cache-control", "content-type", "x-typescript-types"].includes(k));
    const meta: CacheMeta = { url: res.url, code: 200, headers, ctime: Date.now() };
    const [body, bodyCopy] = res.body.tee();
    const saveName = url.search ? urlHash.slice(0, 2) + urlHash : url.pathname;
    writeFileSync(join(this._metaDir, urlHash + ".json"), JSON.stringify(meta), "utf8");
    ensureDir(dirname(join(this._cacheRootDir, saveName)));
    await bodyCopy.pipeTo(Writable.toWeb(createWriteStream(join(this._cacheRootDir, saveName))));
    const resp = new Response(body, { headers });
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
    if (!maxAge || parseInt(maxAge) < 0) {
      rmSync(metaPath);
      return null;
    }
    const saveName = url.search ? urlHash.slice(0, 2) + urlHash : url.pathname;
    const savePath = join(this._cacheRootDir, saveName);
    const hasContent = existsSync(savePath);
    if (!hasContent || meta.ctime + parseInt(maxAge) * 1000 < Date.now()) {
      rmSync(metaPath);
      if (hasContent) {
        rmSync(savePath);
      }
      return null;
    }
    const body = Readable.toWeb(createReadStream(savePath)) as ReadableStream;
    const res = new Response(body, { headers });
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
