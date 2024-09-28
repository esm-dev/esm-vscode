import type ts from "typescript";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { IText, parse, SyntaxKind, walk } from "html5parser";
import { createBlankImportMap, type ImportMap, importMapFrom, isBlankImportMap, resolve } from "./import-map.ts";
import { cache } from "./cache.ts";

class Plugin implements ts.server.PluginModule {
  #typescript: typeof ts;
  #importMap = createBlankImportMap();
  #isBlankImportMap = true;
  #urlMappings = new Map<string, string>();
  #typesMappings = new Map<string, string>();
  #httpImports = new Set<string>();
  #badImports = new Set<string>();
  #fetchPromises = new Map<string, Promise<void>>();

  #getStorePath = (url: URL) => "";
  #updateGraph = () => {};

  constructor(typescript: typeof ts) {
    this.#typescript = typescript;
  }

  get jsxImportSource(): string | undefined {
    const { imports } = this.#importMap;
    for (const specifier of ["@jsxRuntime", "react", "preact", "solid-js", "nano-jsx", "vue"]) {
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
      const log = (...args: unknown[]) => {
        const date = new Date().toISOString();
        const message = [date, ...args.map((a) => typeof a === "object" ? JSON.stringify(a) : a)];
        writeFileSync(logFilepath, message.join(" ") + "\n", { encoding: "utf8", flag: "a+", mode: 0o666 });
      };
      const createLogger = (level: string) => (...args: unknown[]) => log("[" + level + "]", ...args);
      console.log = log;
      console.debug = createLogger("debug");
      console.info = createLogger("info");
      console.warn = createLogger("warn");
      console.error = createLogger("error");
    } else {
      const log = (...args: unknown[]) => {
        const message = ["[esm.sh]", ...args.map((a) => typeof a === "object" ? JSON.stringify(a) : a)];
        project.projectService.logger.info(message.join(" "));
      };
      const createLogger = (level: string) => (...args: unknown[]) => log("[" + level + "]", ...args);
      console.log = log;
      console.debug = () => {};
      console.info = createLogger("info");
      console.warn = createLogger("warn");
      console.error = createLogger("error");
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
    }, 100);

    this.#getStorePath = (url: URL) => {
      const storePath = cache.getStorePath(url);
      setTimeout(() => {
        languageService.getProgram()?.getSourceFile(storePath)?.referencedFiles.forEach((ref) => {
          const refUrl = new URL(ref.fileName, url);
          const refHref = refUrl.href;
          if (/\.d\.(m|c)?ts$/.test(refHref) && !this.#fetchPromises.has(refHref) && !this.#badImports.has(refHref)) {
            this.#fetchPromises.set(
              refHref,
              cache.fetch(refUrl).then(async res => {
                if (res.ok) {
                  if (res.headers.get("cache-status") !== "HIT") {
                    this.#updateGraph();
                  }
                } else {
                  this.#badImports.add(refHref);
                }
              }).catch(err => {
                console.warn(`Failed to fetch types: ${refHref}`, err);
              }).finally(() => {
                this.#fetchPromises.delete(refHref);
              }),
            );
          }
        });
      }, 200);
      return storePath;
    };

    // load import map from index.html if exists
    try {
      const indexHtmlPath = join(cwd, "index.html");
      if (existsSync(indexHtmlPath)) {
        this.#importMap = getImportMapFromHtml(readFileSync(indexHtmlPath, "utf-8"));
        this.#isBlankImportMap = isBlankImportMap(this.#importMap);
        console.info("load importmap from index.html", this.#importMap);
      }
    } catch (error) {
      // failed to load import map from index.html
    }

    // rewrite TS compiler options
    const getCompilationSettings = languageServiceHost.getCompilationSettings.bind(languageServiceHost);
    languageServiceHost.getCompilationSettings = () => {
      const settings: ts.CompilerOptions = getCompilationSettings() ?? {};
      if (!this.#isBlankImportMap) {
        const jsxImportSource = this.jsxImportSource;
        if (jsxImportSource) {
          settings.jsx = this.#typescript.JsxEmit.ReactJSX;
          settings.jsxImportSource = jsxImportSource;
        }
        settings.target ??= this.#typescript.ScriptTarget.ESNext;
        settings.allowArbitraryExtensions = true;
        settings.allowImportingTsExtensions = true;
        settings.allowJs = true;
        settings.useDefineForClassFields = true;
        settings.noEmit = true;
        settings.module = this.#typescript.ModuleKind.ESNext;
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
        return resolvedModules.map((res: ts.ResolvedModuleWithFailedLookupLocations, i: number): typeof res => {
          if (res.resolvedModule) {
            return res;
          }
          try {
            const literal = literals[i];
            const resolvedModule = this.resolveModuleName(literal.text, containingFile);
            if (!resolvedModule) {
              console.debug("unresolved " + literal.text);
            }
            return { resolvedModule };
          } catch (error) {
            console.error("resolveModuleNameLiterals", error.stack ?? error);
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

  onConfigurationChanged(data: { indexHtml: string }): void {
    this.#importMap = getImportMapFromHtml(data.indexHtml);
    this.#isBlankImportMap = isBlankImportMap(this.#importMap);
    this.#updateGraph();
    console.info("onConfigurationChanged", this.#importMap);
  }

  resolveModuleName(specifier: string, containingFile: string): ts.ResolvedModuleFull | undefined {
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
          const resolvedFileName = this.#getStorePath(new URL(dtsRes.url));
          this.#typesMappings.set(moduleHref, resolvedFileName);
          return {
            resolvedFileName,
            resolvedUsingTsExtension: true,
            extension: getScriptExtension(resolvedFileName) ?? ".d.ts",
          };
        }
      } else if (/\.d\.(c|m)?ts$/.test(moduleUrl.pathname)) {
        const resolvedFileName = this.#getStorePath(moduleUrl);
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
        || this.isJsxRuntime(moduleHref)
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
                this.#typesMappings.set(moduleHref, this.#getStorePath(dtsUrl));
              } else {
                // bad response
                this.#badImports.add(moduleHref);
              }
            } else if (/\.d\.(c|m)?ts$/.test(moduleUrl.pathname)) {
              this.#typesMappings.set(moduleHref, this.#getStorePath(moduleUrl));
            } else {
              this.#httpImports.add(moduleHref);
            }
          } else {
            // bad response
            this.#badImports.add(moduleHref);
          }
        }).catch((error) => {
          console.error("fetch module " + moduleUrl, error.stack ?? error);
        }).finally(() => {
          this.#fetchPromises.delete(moduleHref);
          this.#updateGraph();
        }),
      );
    }
    // resolving modules...
    return { resolvedFileName: moduleHref, extension: ".js" };
  }

  isJsxRuntime(url: string): boolean {
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

export function init({ typescript }: { typescript: typeof ts }) {
  return new Plugin(typescript);
}
