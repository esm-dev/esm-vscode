import * as vscode from "vscode";

export async function activate(context: vscode.ExtensionContext) {
  const { workspace } = vscode;
  const tsPlugin = await activateTsPlugin();
  const onIndexHtmlChange = debunce((filename: string, html: string) => tsPlugin.onIndexHtmlChange(filename, html), 500);

  context.subscriptions.push(
    // watch index.html change and notify ts plugin
    workspace.onDidSaveTextDocument((document) => {
      const filepath = document.uri.path;
      if (filepath.endsWith("/index.html")) {
        onIndexHtmlChange(filepath, document.getText());
      }
    }),
  );

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
  return {
    onIndexHtmlChange: (filename: string, html: string) => {
      api.configurePlugin("typescript-esmsh-plugin", { indexHtml: [filename, html] });
    },
  };
}

export function deactivate() {}
