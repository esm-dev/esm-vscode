![Figure #1](https://esm.sh/embed/assets/sceenshot-deno-types.png)

# esm.sh - Visual Studio Code Extension

[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/ije.esm-vscode.svg?color=c19999&amp;label=Marketplace&logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=ije.esm-vscode)

A Visual Studio Code extension loads types(.d.ts) for [esm.sh](https://esm.sh) imports. No `npm install` required. (Types in `node_modules` will be used first, if exists)

## Using Import Maps

This extension respects `importmap` script tag in `index.html` files of your project. With [import maps](https://github.com/WICG/import-maps), you can use "bare import specifiers", such as `import React from "react"`, to work.

```html
<!-- index.html -->

<script type="importmap">
  {
    "imports": {
      "react": "https://esm.sh/react@18.3.1"
    }
  }
</script>
<script type="module" src="./app.tsx"></script>
```

```tsx
// app.tsx

import { useState } from "react";

export default function App() {
  const [message, setMessage] = useState<string>("Hello World!");
  return <h1>{message}</h1>;
}
```

## JSX Import Source

By default, the extension uses [react](https://www.npmjs.com/package/react) or [preact](https://www.npmjs.com/package/preact) as the JSX transform runtime if it's specified in the import map. You can change the JSX import source by setting the `@jsxRuntime` import in the importmap script tag.

```html
<script type="importmap">
  {
    "imports": {
      "@jsxRuntime": "https://esm.sh/react@18.3.1"
    }
  }
</script>
```

## Snippets

This extension provides some useful snippets for working with ESM modules in HTML files.

- `importmap`: Insert a new import map script tag.
- `module`: Insert a new module script tag.
- `module-with-src`: Insert a new module script tag with `src` attribute.
