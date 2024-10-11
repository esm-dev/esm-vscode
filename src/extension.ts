import type { ExtensionContext, Position, QuickPickItem, TextDocument } from "vscode";
import { CodeLens, commands, EndOfLine, extensions, languages, Range, window, workspace, WorkspaceEdit } from "vscode";
import { findImportMapScriptInHtml } from "./import-map";

export async function activate(context: ExtensionContext) {
  languages.registerCodeLensProvider("html", {
    provideCodeLenses: (doc) => {
      try {
        let importMap: { start: number; end: number; value: string } | undefined;
        let importsKey: Position | undefined;
        findImportMapScriptInHtml(doc.getText(), (text) => {
          const r = /"imports":\s*\{/.exec(text.value);
          if (r) {
            importsKey = doc.positionAt(text.start + r.index);
          } else {
            importsKey = doc.positionAt(text.start);
          }
          importMap = text;
        });
        if (importsKey) {
          return [
            new CodeLens(
              new Range(importsKey, importsKey),
              {
                title: "$(sparkle-filled) Search packages on NPM",
                tooltip: "Search packages on NPM",
                command: "ije.esmsh.search-npm-package",
                arguments: [doc, importMap],
              },
            ),
          ];
        }
      } catch (_) {}
      return [];
    },
  });
  commands.registerCommand(
    "ije.esmsh.search-npm-package",
    async (doc: TextDocument, importMap: { start: number; end: number; value: string }) => {
      const keyword = await window.showInputBox({
        placeHolder: "Enter package name, e.g. lodash",
        validateInput: (value) => {
          return /^[\w\-\.@]+$/.test(value) ? null : "Invalid package name, only word characters are allowed";
        },
      });
      if (!keyword) {
        return;
      }
      const pkg = await window.showQuickPick(searchPackagesFromNpm(keyword, 32), {
        placeHolder: "Select a package",
        matchOnDetail: true,
      });
      if (!pkg) {
        return;
      }
      const { imports = {}, scopes = {} } = JSON.parse(importMap.value);
      const specifier = "https://esm.sh/" + pkg.name + "@" + pkg.version;
      if (imports[pkg.name] === specifier) {
        return;
      }
      imports[pkg.name] = specifier;
      const json = JSON.stringify({ imports, scopes: Object.keys(scopes).length > 0 ? scopes : undefined }, null, 2);
      const indent = /^[\n\r]+\t+/.test(importMap.value) ? "\t" : "  ";
      const eol = doc.eol === EndOfLine.LF ? "\n" : "\r\n";
      const formattedJson = eol + json.split("\n").map((line, i) => indent.repeat(2) + line).join(eol) + eol + indent;
      const edit = new WorkspaceEdit();
      edit.replace(doc.uri, new Range(doc.positionAt(importMap.start), doc.positionAt(importMap.end)), formattedJson);
      await workspace.applyEdit(edit);
    },
  );
  await activateTsPlugin();
}

async function activateTsPlugin() {
  const tsExtension = extensions.getExtension("vscode.typescript-language-features");
  if (!tsExtension) {
    throw new Error("vscode.typescript-language-features not found");
  }
  await tsExtension.activate();
  const api = tsExtension.exports.getAPI(0);
  if (!api) {
    throw new Error("vscode.typescript-language-features api not found");
  }
  return api;
}

async function searchPackagesFromNpm(keyword: string, size = 20) {
  const res = await fetch(`https://registry.npmjs.com/-/v1/search?text=${keyword}&size=${size}`);
  if (!res.ok) {
    throw new Error(`Failed to search npm packages: ${res.statusText}`);
  }
  const { objects } = await res.json();
  if (!Array.isArray(objects)) {
    return [];
  }
  const items: (QuickPickItem & { name: string; version: string })[] = new Array(objects.length);
  let len = 0;
  for (const { package: pkg } of objects) {
    if (!pkg.name.startsWith("@types/")) {
      items[len] = {
        label: (keyword === pkg.name ? "$(star-empty) " : "") + pkg.name,
        description: pkg.version,
        detail: pkg.description,
        name: pkg.name,
        version: pkg.version,
      };
      len++;
    }
  }
  return items.slice(0, len);
}

export function deactivate() {}
