import type ts from "typescript";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { IText, parse, SyntaxKind, walk } from "html5parser";
import { createBlankImportMap, type ImportMap, importMapFrom, isBlankImportMap, isSame, resolve } from "./import-map.ts";
import { cache } from "./cache.ts";

let console: Pick<Console, "debug" | "log" | "info" | "warn" | "error"> = globalThis.console;

class Plugin implements ts.server.PluginModule {
  #typescript: typeof ts;
  #importMaps = new Map<string, ImportMap>();
  #urlMappings = new Map<string, string>();
  #typesMappings = new Map<string, string>();
  #httpImports = new Set<string>();
  #badImports = new Set<string>();
  #fetchPromises = new Map<string, Promise<void>>();
  #projectDir = "";
  #updateGraph = () => {};

  constructor(typescript: typeof ts) {
    this.#typescript = typescript;
  }

  create(info: ts.server.PluginCreateInfo): ts.LanguageService {
    const { languageService, languageServiceHost, project } = info;
    const stringify = (a: unknown) => typeof a === "object" ? (a instanceof Error ? a.stack ?? a.message : JSON.stringify(a)) : a;

    // store the project directory
    this.#projectDir = project.getCurrentDirectory();

    // @ts-ignore DEBUG is defined at build time
    if (DEBUG) {
      const logFilepath = join(this.#projectDir, "typescript-esmsh-plugin.log");
      const log = (...args: unknown[]) => {
        const date = new Date().toISOString();
        const message = [date, ...args.map(stringify)];
        writeFileSync(logFilepath, message.join(" ") + "\n", { encoding: "utf8", flag: "a+", mode: 0o666 });
      };
      const createLogger = (level: string) => (...args: unknown[]) => log("[" + level + "]", ...args);
      console = {
        log,
        debug: createLogger("debug"),
        info: createLogger("info"),
        warn: createLogger("warn"),
        error: createLogger("error"),
      };
    } else {
      const log = (...args: unknown[]) => {
        const message = ["[esm.sh]", ...args.map(stringify)];
        project.projectService.logger.info(message.join(" "));
      };
      const createLogger = (level: string) => (...args: unknown[]) => log("[" + level + "]", ...args);
      console = {
        log,
        debug: () => {},
        info: createLogger("info"),
        warn: createLogger("warn"),
        error: createLogger("error"),
      };
    }

    this.#updateGraph = debunce(() => {
      const { projectService } = project;
      projectService.getScriptInfo;
      // @ts-ignore internal APIs
      const clearSemanticCache = projectService.clearSemanticCache.bind(projectService);
      if (clearSemanticCache) {
        clearSemanticCache(project);
        project.updateGraph();
      } else {
        // in case TS changes it's internal APIs, we fallback to force reload all projects
        projectService.reloadProjects();
      }
    }, 500);

    // load import map from index.html if exists
    const entries = project.readDirectory(this.#projectDir, [".html"]);
    for (const entry of entries) {
      if (entry.endsWith("/index.html")) {
        try {
          const html = project.readFile(entry)!;
          const importMap = getImportMapFromHtml(entry, html);
          if (!isBlankImportMap(importMap)) {
            this.#importMaps.set(entry, importMap);
            console.info("import map loaded", importMap);
          }
        } catch (error) {
          console.warn("failed to load import map from", entry, error);
        }
      }
    }

    // rewrite TS compiler options
    const getCompilationSettings = languageServiceHost.getCompilationSettings.bind(languageServiceHost);
    languageServiceHost.getCompilationSettings = () => {
      const settings: ts.CompilerOptions = getCompilationSettings() ?? {};
      if (this.#importMaps.size > 0) {
        const ts = this.#typescript;
        settings.target ??= ts.ScriptTarget.ESNext;
        settings.allowArbitraryExtensions = true;
        settings.allowImportingTsExtensions = true;
        settings.allowJs = true;
        settings.useDefineForClassFields = true;
        settings.noEmit = true;
        settings.module = ts.ModuleKind.ESNext;
        settings.moduleResolution = ts.ModuleResolutionKind.Bundler;
        settings.moduleDetection = ts.ModuleDetectionKind.Force;
        settings.isolatedModules = true;
        settings.jsx = ts.JsxEmit.ReactJSX;
        settings.jsxImportSource = "@jsxImportSource";
      }
      return settings;
    };

    // hijack resolveModuleNameLiterals
    const resolveModuleNameLiterals = languageServiceHost.resolveModuleNameLiterals?.bind(languageServiceHost);
    if (resolveModuleNameLiterals) {
      languageServiceHost.resolveModuleNameLiterals = (literals, containingFile: string, ...rest) => {
        const resolvedModules = resolveModuleNameLiterals(literals, containingFile, ...rest);
        setTimeout(() => {
          // @ts-ignore `missingFilesMap` is a private property of `project`
          const missingFiles = [...project.missingFilesMap.keys()].filter(filename =>
            filename.startsWith(cache.storeDir) || filename.startsWith(cache.storeDir.toLowerCase())
          );
          missingFiles.forEach(filename => {
            const refUrl = cache.restoreUrl(filename);
            const refHref = refUrl.href;
            if (/\.d\.(m|c)?ts$/.test(refHref) && !this.#badImports.has(refHref) && !this.#fetchPromises.has(refHref)) {
              this.#fetchPromises.set(
                refHref,
                cache.fetch(refUrl).then(async res => {
                  if (!res.ok) {
                    this.#badImports.add(refHref);
                  } else {
                    console.debug("fetched missing types", refHref);
                  }
                }).catch(err => {
                  console.warn(`Failed to fetch missing types(${refHref}):`, err);
                }).finally(() => {
                  this.#fetchPromises.delete(refHref);
                }),
              );
            }
          });
        });
        return resolvedModules.map((res: ts.ResolvedModuleWithFailedLookupLocations, i: number): typeof res => {
          if (res.resolvedModule) {
            return res;
          }
          try {
            const literal = literals[i];
            const resolvedModule = this.resolveModuleName(literal.text, containingFile);
            if (!resolvedModule) {
              console.debug("unresolved", JSON.stringify(literal.text), "in", containingFile);
            }
            return { resolvedModule };
          } catch (error) {
            console.error("resolveModuleNameLiterals", error);
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

    console.info("plugin created, typescrpt v" + this.#typescript.version);
    return languageService;
  }

  onConfigurationChanged(data: { indexHtml: [string, string] }): void {
    try {
      const [filepath, html] = data.indexHtml;
      const importMap = getImportMapFromHtml(filepath, html);
      const oldImportMap = this.#importMaps.get(filepath);
      if (!oldImportMap || !isSame(importMap, oldImportMap)) {
        if (isBlankImportMap(importMap)) {
          this.#importMaps.delete(filepath);
        } else {
          this.#importMaps.set(filepath, importMap);
        }
        this.#updateGraph();
        console.info("import map updated", importMap);
      }
    } catch (error) {
      console.warn("failed to update import map from", data?.indexHtml?.[0], error);
    }
  }

  resolveModuleName(specifier: string, containingFile: string): ts.ResolvedModuleFull | undefined {
    let importMapResolved = false;
    if (this.#importMaps.size > 0) {
      if (containingFile.startsWith(this.#projectDir)) {
        const scopeImportMaps: ImportMap[] = [];
        for (const [fp, im] of this.#importMaps) {
          const scope = fp.slice(0, -10); // remove "/index.html"
          if (containingFile.startsWith(scope)) {
            scopeImportMaps.push(im);
          }
        }
        if (scopeImportMaps.length > 0) {
          scopeImportMaps.sort((a, b) => orderByPathSegments(a.$src!, b.$src!));
          const [url, resolved] = resolveSpecifierFromImportMaps(scopeImportMaps, specifier, containingFile);
          if (resolved) {
            importMapResolved = true;
            specifier = url;
          }
        }
      }
      if (!importMapResolved) {
        const [url, resolved] = resolveSpecifierFromImportMaps(this.#importMaps.values(), specifier, containingFile);
        if (resolved) {
          importMapResolved = true;
          specifier = url;
        }
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
      if (ext === ".d.ts" || ext === ".d.mts" || ext === ".d.cts") {
        // use the extension of the containing file which is a dts file
        // if the module name has no extension.
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
        return this.resolveModuleName(specifier, url.href);
      }
      return undefined;
    }
    if (this.#badImports.has(moduleHref)) {
      return undefined;
    }
    if (this.#urlMappings.has(moduleHref)) {
      const redirectUrl = this.#urlMappings.get(moduleHref)!;
      return this.resolveModuleName(redirectUrl, containingFile);
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
    const res = cache.query(moduleUrl);
    if (res) {
      const dts = res.headers.get("x-typescript-types");
      if (res.redirected) {
        this.#urlMappings.set(moduleHref, res.url);
        return this.resolveModuleName(res.url, containingFile);
      } else if (dts) {
        let dtsRes = cache.query(new URL(dts, moduleUrl));
        if (dtsRes) {
          const resolvedFileName = cache.getStorePath(new URL(dtsRes.url));
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
        || isWellKnownCDNURL(moduleUrl);
      const promise = autoFetch ? cache.fetch(moduleUrl) : Promise.resolve(cache.query(moduleUrl));
      this.#fetchPromises.set(
        moduleHref,
        promise.then(async (res) => {
          if (!res) {
            this.#httpImports.add(moduleHref);
            return;
          }
          if (res.redirected) {
            this.#urlMappings.set(moduleHref, res.url);
          } else if (res.ok) {
            const dts = res.headers.get("x-typescript-types");
            if (dts) {
              let dtsRes = await cache.fetch(new URL(dts, res.url));
              if (dtsRes.ok) {
                const dtsUrl = new URL(dtsRes.url);
                this.#typesMappings.set(moduleHref, cache.getStorePath(dtsUrl));
                console.debug("found types", moduleHref, "->", dtsUrl.href);
              } else {
                this.#badImports.add(moduleHref);
              }
            } else if (/\.d\.(c|m)?ts$/.test(moduleUrl.pathname)) {
              this.#typesMappings.set(moduleHref, cache.getStorePath(moduleUrl));
            } else {
              this.#httpImports.add(moduleHref);
            }
          } else {
            this.#badImports.add(moduleHref);
          }
        }).catch((error) => {
          console.error("fetch module " + moduleUrl, error);
        }).finally(() => {
          this.#fetchPromises.delete(moduleHref);
          this.#updateGraph();
        }),
      );
    }
    return { resolvedFileName: moduleHref, extension: ".js" };
  }
}

function getImportMapFromHtml(src: string, html: string): ImportMap {
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
            importMap.$src = src;
          }
        }
      },
    });
  } catch (err) {
    console.error(err);
  }
  return importMap;
}

function resolveSpecifierFromImportMaps(importMaps: Iterable<ImportMap>, specifier: string, containingFile: string): [string, boolean] {
  for (const im of importMaps) {
    const [url, resolved] = resolve(im, specifier, containingFile);
    if (resolved) {
      return [url, resolved];
    }
  }
  if (specifier === "@jsxImportSource/jsx-runtime") {
    for (const jsxRuntime of ["react", "preact"]) {
      for (const im of importMaps) {
        const [url, resolved] = resolve(im, jsxRuntime, containingFile);
        if (resolved) {
          return [url, resolved];
        }
      }
    }
  }
  return [specifier, false];
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

const regexpPackagePath =
  /\/((@|gh\/|pr\/|jsr\/@)[\w\.\-]+\/)?[\w\.\-]+@(\d+(\.\d+){0,2}(\-[\w\.]+)?|next|canary|rc|beta|latest)(\/(client|server|internal|hooks|store|utils?|types|components))?$/;
function isWellKnownCDNURL(url: URL): boolean {
  const { pathname } = url;
  return regexpPackagePath.test(pathname);
}

function toUrl(path: string): string {
  return new URL(path, "file:///").href;
}

function debunce<T extends (...args: any[]) => unknown>(fn: T, ms: number): (...args: Parameters<T>) => void {
  let timer: number | undefined;
  return ((...args: any[]) => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      fn(...args);
    }, ms) as unknown as number;
  });
}

function orderByPathSegments(a: string, b: string): number {
  return b.split("/").length - a.split("/").length;
}

export function init({ typescript }: { typescript: typeof ts }) {
  return new Plugin(typescript);
}
