/** The import maps follow the spec at https://wicg.github.io/import-maps/. */
export interface ImportMap {
  $baseURL: string;
  $src?: string;
  $support?: boolean;
  imports: Record<string, string>;
  scopes: Record<string, Record<string, string>>;
}

/** Create a blank import map. */
export function createBlankImportMap(baseURL?: string): ImportMap {
  return {
    $baseURL: new URL(baseURL ?? ".", "file:///").href,
    $support: globalThis.HTMLScriptElement?.supports?.("importmap"),
    imports: {},
    scopes: {},
  };
}

/** Check if the import map is blank. */
export function isBlankImportMap(importMap: ImportMap) {
  if (
    (isObject(importMap.imports) && Object.keys(importMap.imports).length > 0)
    || (isObject(importMap.scopes) && Object.keys(importMap.scopes).length > 0)
  ) {
    return false;
  }
  return true;
}

/** Validate the given import map. */
export function importMapFrom(v: any, baseURL?: string): ImportMap {
  const im = createBlankImportMap(baseURL);
  if (isObject(v)) {
    const { imports, scopes } = v;
    if (isObject(imports)) {
      validateImports(imports);
      im.imports = imports as ImportMap["imports"];
    }
    if (isObject(scopes)) {
      validateScopes(scopes);
      im.scopes = scopes as ImportMap["scopes"];
    }
  }
  return im;
}

/** Parse the import map from JSON. */
export function parseImportMapFromJson(json: string, baseURL?: string): ImportMap {
  const importMap: ImportMap = {
    $baseURL: new URL(baseURL ?? ".", "file:///").href,
    $support: globalThis.HTMLScriptElement?.supports?.("importmap"),
    imports: {},
    scopes: {},
  };
  const v = JSON.parse(json);
  if (isObject(v)) {
    const { imports, scopes } = v;
    if (isObject(imports)) {
      validateImports(imports);
      importMap.imports = imports as ImportMap["imports"];
    }
    if (isObject(scopes)) {
      validateScopes(scopes);
      importMap.scopes = scopes as ImportMap["scopes"];
    }
  }
  return importMap;
}

/** Resolve the specifier with the import map. */
export function resolve(importMap: ImportMap, specifier: string, containingFile: string): [string, boolean] {
  const { $baseURL, imports, scopes } = importMap;
  const { origin, pathname } = new URL(containingFile, $baseURL);
  const sameOriginScopes: [string, ImportMap["imports"]][] = [];
  for (const scopeName in scopes) {
    const scopeUrl = new URL(scopeName, $baseURL);
    if (scopeUrl.origin === origin) {
      sameOriginScopes.push([scopeUrl.pathname, scopes[scopeName]]);
    }
  }
  sameOriginScopes.sort(([a], [b]) => b.split("/").length - a.split("/").length);
  if (sameOriginScopes.length > 0) {
    for (const [scopePathname, scopeImports] of sameOriginScopes) {
      if (pathname.startsWith(scopePathname)) {
        const match = matchImportUrl(specifier, scopeImports);
        if (match) {
          return [match, true];
        }
      }
    }
  }
  if (origin === new URL($baseURL).origin) {
    const match = matchImportUrl(specifier, imports);
    if (match) {
      return [match, true];
    }
  }
  return [specifier, false];
}

function matchImportUrl(specifier: string, imports: ImportMap["imports"]): string | null {
  if (specifier in imports) {
    return imports[specifier];
  }
  for (const [k, v] of Object.entries(imports)) {
    if (k.endsWith("/")) {
      if (specifier.startsWith(k)) {
        return v + specifier.slice(k.length);
      }
    } else if (specifier.startsWith(k + "/")) {
      return v + specifier.slice(k.length);
    }
  }
  return null;
}

function validateImports(imports: Record<string, unknown>) {
  for (const [k, v] of Object.entries(imports)) {
    if (!v || typeof v !== "string") {
      delete imports[k];
    }
  }
}

function validateScopes(imports: Record<string, unknown>) {
  for (const [k, v] of Object.entries(imports)) {
    if (isObject(v)) {
      validateImports(v);
    } else {
      delete imports[k];
    }
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
