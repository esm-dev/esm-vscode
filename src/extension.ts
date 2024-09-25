import * as vscode from "vscode";

export async function activate(context: vscode.ExtensionContext) {
  const { workspace } = vscode;
  const tsPlugin = await activateTsPlugin();
  const onIndexHtmlChange = debunce((html: string) => tsPlugin.onIndexHtmlChange(html), 500);

  context.subscriptions.push(
    // watch index.html change and notify ts plugin
    workspace.onDidSaveTextDocument((document) => {
      const name = workspace.asRelativePath(document.uri);
      if (name === "index.html") {
        onIndexHtmlChange(document.getText());
      }
    }),
  );

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
  let indexHtml = "";
  return {
    onIndexHtmlChange: (html: string) => {
      if (html !== indexHtml) {
        indexHtml = html;
        api.configurePlugin("typescript-esmsh-plugin", { indexHtml });
      }
    },
  };
}

export function deactivate() {}
