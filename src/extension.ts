import * as vscode from "vscode";

export async function activate(context: vscode.ExtensionContext) {
  const { languages } = vscode;
  await activateTsPlugin();
}

async function activateTsPlugin() {
  const tsExtension = vscode.extensions.getExtension("vscode.typescript-language-features");
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

export function deactivate() {}
