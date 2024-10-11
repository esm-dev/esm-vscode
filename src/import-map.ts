/** The ImportMap interface follow the spec at https://wicg.github.io/import-maps/. */
export interface ImportMap {
  $baseURL: string;
  $src?: string;
  imports: Record<string, string>;
  scopes: Record<string, Record<string, string>>;
}

/** Create a blank import map. */
export function createBlankImportMap(baseURL?: string): ImportMap {
  return {
    $baseURL: new URL(baseURL ?? ".", "file:///").href,
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

/** Check if the two import maps are the same. */
export function isSame(a: ImportMap, b: ImportMap): boolean {
  if (!isSameImports(a.imports, b.imports)) {
    return false;
  }
  for (const k in a.scopes) {
    if (!(k in b.scopes) || !isObject(b.scopes[k])) {
      return false;
    }
    if (!isSameImports(a.scopes[k], b.scopes[k])) {
      return false;
    }
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

/** Parse the import map from the given HTML. */
export function importMapFromHtml(src: string, html: string): ImportMap {
  let importMap = createBlankImportMap();
  try {
    findImportMapScriptInHtml(html, (text) => {
      const v = JSON.parse(text.value);
      if (v && typeof v === "object" && !Array.isArray(v)) {
        importMap = importMapFrom(v);
        importMap.$src = src;
      }
    });
  } catch (err) {
    console.error("failed to parse import map from", src, err);
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

function isSameImports(a: Record<string, string>, b: Record<string, string>): boolean {
  if (Object.keys(a).length !== Object.keys(b).length) {
    return false;
  }
  for (const k in a) {
    if (a[k] !== b[k]) {
      return false;
    }
  }
  return true;
}

import { INode, IText, parse, SyntaxKind } from "html5parser";

type VisitFn = (node: INode, parent: INode | undefined, index: number) => false | void;

function visit(node: INode, parent: INode | undefined, index: number, enter: VisitFn): false | void {
  if (enter(node, parent, index) === false) {
    return false;
  }
  if (node.type === SyntaxKind.Tag && Array.isArray(node.body)) {
    for (let i = 0; i < node.body.length; i++) {
      if (visit(node.body[i], node, i, enter) === false) {
        return false;
      }
    }
  }
}

function walkHtml(html: string, enter: VisitFn) {
  const ast = parse(html);
  for (let i = 0; i < ast.length; i++) {
    if (visit(ast[i], void 0, i, enter) === false) {
      break;
    }
  }
}

export function findImportMapScriptInHtml(html: string, callback: (text: IText, node: INode) => void) {
  walkHtml(html, (node) => {
    if (
      node.type === SyntaxKind.Tag && node.name === "script"
      && node.attributes.some((a) => a.name.value === "type" && a.value?.value === "importmap")
      && node.body && node.body.length === 1 && node.body[0].type === SyntaxKind.Text
    ) {
      callback(node.body[0] as IText, node);
      return false;
    }
  });
}
