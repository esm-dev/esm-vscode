import { build as esbuild } from "esbuild";

const build = (options) => {
  return esbuild({
    target: "node20",
    format: "cjs",
    platform: "node",
    target: "es2022",
    outdir: "dist",
    bundle: true,
    minify: !process.env.DEBUG,
    logLevel: "info",
    external: ["vscode", "typescript"],
    loader: {
      ".wasm": "binary",
    },
    define: {
      "DEBUG": process.env.DEBUG ? "true" : "false",
    },
    ...options,
  });
};

await build({
  entryPoints: ["src/extension.ts"],
});

await build({
  entryPoints: ["src/typescript-esmsh-plugin.ts"],
  outdir: "typescript-esmsh-plugin/dist",
});
