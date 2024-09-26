import type ts from "typescript/lib/tsserverlibrary";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { IText, parse, SyntaxKind, walk } from "html5parser";
import { createBlankImportMap, type ImportMap, importMapFrom, isBlankImportMap, resolve } from "./import-map.ts";
import { cache } from "./cache.ts";

class Plugin implements ts.server.PluginModule {
  #typescript: typeof ts;
  #importMap = createBlankImportMap();
  #isBlankImportMap = true;
  #httpRedirects = new Map<string, string>();
  #typesMappings = new Map<string, string>();
  #redirectImports: [modelUrl: string, node: ts.Node, url: string][] = [];
  #httpImports = new Set<string>();
  #badImports = new Set<string>();
  #fetchPromises = new Map<string, Promise<void>>();

  #refreshDiagnostics = () => {};
  #debug = (s: string, ...args: any[]) => {};

  constructor(typescript: typeof ts) {
    this.#typescript = typescript;
  }

  get jsxImportSource(): string | undefined {
    const { imports } = this.#importMap;
    for (const specifier of ["@jsxRuntime", "@jsxImportSource", "react", "preact", "solid-js", "vue", "nano-jsx"]) {
      if (specifier in imports) {
        return imports[specifier];
      }
    }
    return undefined;
  }

  create(info: ts.server.PluginCreateInfo): ts.LanguageService {
    const { languageService, languageServiceHost, project } = info;
    const cwd = project.getCurrentDirectory();

    // @ts-ignore DEBUG is defined at build time
    if (DEBUG) {
      const logFilepath = join(cwd, "typescript-esmsh-plugin.log");
      writeFileSync(logFilepath, "-".repeat(80) + "\n", { encoding: "utf8", flag: "a+", mode: 0o666 });
      this.#debug = (s: string, ...args: any[]) => {
        const lines = [`[${new Date().toUTCString()}] ` + s];
        if (args.length) {
          lines.push("```");
          lines.push(...args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg, undefined, 2)));
          lines.push("```");
        }
        writeFileSync(logFilepath, lines.join("\n") + "\n", { encoding: "utf8", flag: "a+", mode: 0o666 });
      };
    }

    // reload projects and refresh diagnostics
    this.#refreshDiagnostics = debunce(() => {
      // @ts-ignore internal APIs
      const cleanupProgram = project.cleanupProgram.bind(project), markAsDirty = project.markAsDirty.bind(project);
      if (cleanupProgram && markAsDirty) {
        cleanupProgram();
        markAsDirty();
        languageService.cleanupSemanticCache();
        project.updateGraph();
      } else {
        // in case TS changes it's internal APIs, we fallback to force reload the projects
        project.projectService.reloadProjects();
      }
    }, 100);

    // load import map from index.html if exists
    try {
      const indexHtmlPath = join(cwd, "index.html");
      if (existsSync(indexHtmlPath)) {
        this.#importMap = getImportMapFromHtml(readFileSync(indexHtmlPath, "utf-8"));
        this.#isBlankImportMap = isBlankImportMap(this.#importMap);
        this.#debug("load importmap from index.html", this.#importMap);
      }
    } catch (error) {
      // ignore
    }

    // rewrite TS compiler options
    const getCompilationSettings = languageServiceHost.getCompilationSettings.bind(languageServiceHost);
    languageServiceHost.getCompilationSettings = () => {
      const settings: ts.CompilerOptions = getCompilationSettings();
      if (!this.#isBlankImportMap) {
        const jsxImportSource = this.jsxImportSource;
        if (jsxImportSource) {
          settings.jsx = this.#typescript.JsxEmit.ReactJSX;
          settings.jsxImportSource = jsxImportSource;
        }
        settings.target ??= this.#typescript.ScriptTarget.ESNext;
        settings.allowImportingTsExtensions = true;
        settings.skipLibCheck = true;
        settings.noEmit = true;
        settings.moduleResolution = this.#typescript.ModuleResolutionKind.Bundler;
        settings.moduleDetection = this.#typescript.ModuleDetectionKind.Force;
        settings.isolatedModules = true;
      }
      return settings;
    };

    // hijack resolveModuleNameLiterals
    const resolveModuleNameLiterals = languageServiceHost.resolveModuleNameLiterals?.bind(languageServiceHost);
    if (resolveModuleNameLiterals) {
      languageServiceHost.resolveModuleNameLiterals = (literals, containingFile: string, ...rest) => {
        const resolvedModules = resolveModuleNameLiterals(literals, containingFile, ...rest);
        this.#redirectImports = this.#redirectImports.filter(([modelUrl]) => modelUrl !== containingFile);
        return resolvedModules.map((res: ts.ResolvedModuleWithFailedLookupLocations, i: number): typeof res => {
          if (res.resolvedModule) {
            return res;
          }
          try {
            return { resolvedModule: this.resolveModuleName(literals[i], containingFile) };
          } catch (error) {
            this.#debug("[error] resolveModuleNameLiterals", error.stack ?? error);
            return { resolvedModule: undefined };
          }
        });
      };
    }

    // fix invalid auto imports
    const getCompletionsAtPosition = languageService.getCompletionsAtPosition;
    languageService.getCompletionsAtPosition = (fileName, position, options) => {
      const result = getCompletionsAtPosition(fileName, position, options);
      if (result) {
        result.entries = result.entries.filter((entry) => {
          return !entry.source?.includes("../.cache/esm.sh/");
        });
      }
      return result;
    };

    this.#debug("plugin created, typescrpt v" + this.#typescript.version);
    return languageService;
  }

  onConfigurationChanged(data: { indexHtml: string }): void {
    this.#importMap = getImportMapFromHtml(data.indexHtml);
    this.#isBlankImportMap = isBlankImportMap(this.#importMap);
    this.#refreshDiagnostics();
    this.#debug("onConfigurationChanged", this.#importMap);
  }

  resolveModuleName(literal: ts.StringLiteralLike, containingFile: string): ts.ResolvedModuleFull | undefined {
    let specifier = literal.text;
    let importMapResolved = false;
    if (!this.#isBlankImportMap) {
      const [url, resolved] = resolve(this.#importMap, specifier, containingFile);
      importMapResolved = resolved;
      if (importMapResolved) {
        specifier = url;
      }
    }
    if (!importMapResolved && !isHttpUrl(specifier) && !isRelativePath(specifier)) {
      return undefined;
    }
    let moduleUrl: URL;
    try {
      moduleUrl = new URL(specifier, new URL(containingFile, "file:///"));
    } catch (error) {
      return undefined;
    }
    if (getScriptExtension(moduleUrl.pathname) === null) {
      const ext = getScriptExtension(containingFile);
      // use the extension of the containing file which is a dts file
      // when the module name has no extension.
      if (ext === ".d.ts" || ext === ".d.mts" || ext === ".d.cts") {
        moduleUrl.pathname += ext;
      }
    }
    const moduleHref = moduleUrl.href;
    if (moduleUrl.protocol === "file:") {
      if (toUrl(containingFile).startsWith(toUrl(cache.storeDir))) {
        const url = new URL(toUrl(containingFile).substring(toUrl(cache.storeDir).length), "https://esm.sh/");
        if (url.pathname.startsWith("/-/")) {
          const [host, ...rest] = url.pathname.slice(3).split("/");
          url.host = host;
          url.pathname = "/" + rest.join("/");
        }
        return this.resolveModuleName(literal, url.href);
      }
      return undefined;
    }
    if (this.#badImports.has(moduleHref)) {
      return undefined;
    }
    if (!importMapResolved && this.#httpRedirects.has(moduleHref)) {
      const redirectUrl = this.#httpRedirects.get(moduleHref)!;
      this.#redirectImports.push([containingFile, literal, redirectUrl]);
    }
    if (this.#typesMappings.has(moduleHref)) {
      const resolvedFileName = this.#typesMappings.get(moduleHref)!;
      return {
        resolvedFileName,
        resolvedUsingTsExtension: true,
        extension: getScriptExtension(resolvedFileName) ?? ".d.ts",
      };
    }
    if (this.#httpImports.has(moduleHref)) {
      return { resolvedFileName: moduleHref, extension: ".js" };
    }
    const res = cache.head(moduleUrl);
    if (res) {
      const dts = res.headers.get("x-typescript-types");
      if (dts) {
        const dtsUrl = new URL(dts, moduleUrl);
        const dtsRes = cache.head(dtsUrl);
        if (dtsRes) {
          const resolvedFileName = cache.getStorePath(dtsUrl);
          this.#typesMappings.set(moduleHref, resolvedFileName);
          return {
            resolvedFileName,
            resolvedUsingTsExtension: true,
            extension: getScriptExtension(resolvedFileName) ?? ".d.ts",
          };
        }
      } else if (/\.d\.(c|m)?ts$/.test(moduleUrl.pathname)) {
        const resolvedFileName = cache.getStorePath(moduleUrl);
        this.#typesMappings.set(moduleHref, resolvedFileName);
        return {
          resolvedFileName,
          resolvedUsingTsExtension: true,
          extension: getScriptExtension(resolvedFileName) ?? ".d.ts",
        };
      }
      this.#httpImports.add(moduleHref);
      return { resolvedFileName: moduleHref, extension: ".js" };
    }
    if (!this.#fetchPromises.has(moduleHref)) {
      const autoFetch = importMapResolved
        || isHttpUrl(containingFile)
        || toUrl(containingFile).startsWith(toUrl(cache.storeDir))
        || this.isJsxImportUrl(moduleHref)
        || isWellKnownCDNURL(moduleUrl);
      const promise = autoFetch ? cache.fetch(moduleUrl) : cache.query(moduleUrl);
      this.#fetchPromises.set(
        moduleHref,
        promise.then(async (res) => {
          // if do not find the module in the cache
          if (!res) {
            this.#httpImports.add(moduleHref);
            return;
          }
          if (res.ok) {
            const dts = res.headers.get("x-typescript-types");
            if (res.redirected) {
              this.#httpRedirects.set(moduleHref, res.url);
            } else if (dts) {
              const dtsUrl = new URL(dts, moduleUrl);
              const dtsRes = await cache.fetch(dtsUrl);
              if (dtsRes.ok) {
                this.#typesMappings.set(moduleHref, cache.getStorePath(dtsUrl));
              } else {
                // bad response
                this.#badImports.add(moduleHref);
              }
            } else if (/\.d\.(c|m)?ts$/.test(moduleUrl.pathname)) {
              this.#typesMappings.set(moduleHref, cache.getStorePath(moduleUrl));
            } else {
              this.#httpImports.add(moduleHref);
            }
          } else {
            // bad response
            this.#badImports.add(moduleHref);
          }
        }).catch((error) => {
          this.#debug("[error] fetch module", error.stack ?? error);
        }).finally(() => {
          this.#fetchPromises.delete(moduleHref);
          this.#refreshDiagnostics();
        }),
      );
    }
    // resolving modules...
    return { resolvedFileName: moduleHref, extension: ".js" };
  }

  isJsxImportUrl(url: string): boolean {
    const jsxImportSource = this.jsxImportSource;
    if (jsxImportSource) {
      return url === jsxImportSource + "/jsx-runtime" || url === jsxImportSource + "/jsx-dev-runtime";
    }
    return false;
  }
}

function getImportMapFromHtml(html: string): ImportMap {
  let importMap = createBlankImportMap();
  try {
    walk(parse(html), {
      enter: (node) => {
        if (
          node.type === SyntaxKind.Tag && node.name === "script" && node.body
          && node.attributes.some((a) => a.name.value === "type" && a.value?.value === "importmap")
        ) {
          const v = JSON.parse(node.body.map((a) => (a as IText).value).join(""));
          if (v && typeof v === "object" && !Array.isArray(v)) {
            importMap = importMapFrom(v);
          }
        }
      },
    });
  } catch (err) {
    console.error(err);
  }
  return importMap;
}

function getScriptExtension(pathname: string): string | null {
  const basename = pathname.substring(pathname.lastIndexOf("/") + 1);
  const dotIndex = basename.lastIndexOf(".");
  if (dotIndex === -1) {
    return null;
  }
  const ext = basename.substring(dotIndex + 1);
  switch (ext) {
    case "ts":
      return basename.endsWith(".d.ts") ? ".d.ts" : ".ts";
    case "mts":
      return basename.endsWith(".d.mts") ? ".d.mts" : ".mts";
    case "cts":
      return basename.endsWith(".d.cts") ? ".d.cts" : ".cts";
    case "tsx":
      return ".tsx";
    case "js":
      return ".js";
    case "mjs":
      return ".js";
    case "cjs":
      return ".cjs";
    case "jsx":
      return ".jsx";
    case "json":
      return ".json";
    default:
      return ".js";
  }
}

function isHttpUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

function isRelativePath(path: string): boolean {
  return path.startsWith("./") || path.startsWith("../");
}

const regexpPackagePath = /\/((@|gh\/|pr\/|jsr\/@)[\w\.\-]+\/)?[\w\.\-]+@(\d+(\.\d+){0,2}(\-[\w\.]+)?|next|canary|rc|beta|latest)$/;
function isWellKnownCDNURL(url: URL): boolean {
  const { pathname } = url;
  return regexpPackagePath.test(pathname);
}

function toUrl(path: string): string {
  return new URL(path, "file:///").href;
}

function debunce<T extends (...args: any[]) => unknown>(fn: T, timeout: number): (...args: Parameters<T>) => void {
  let timer: number | undefined;
  return ((...args: any[]) => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      fn(...args);
    }, timeout) as unknown as number;
  });
}

export function init({ typescript }: { typescript: typeof ts }) {
  return new Plugin(typescript);
}
