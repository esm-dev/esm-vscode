![Figure #1](https://esm.sh/embed/assets/sceenshot-deno-types.png)

# esm.sh for VS Code

A VS Code extension loads types from [esm.sh](https://esm.sh) CDN for http imports. No `npm install` required. (Types in `node_modules` will be used first, if exists)

## Using Import Maps

This extension respects `importmap` script tag in the `index.html` of your project root. With [import maps](https://github.com/WICG/import-maps), you can use "bare import specifiers", such as `import React from "react"`, to work.

```html
<!-- index.html -->

<script type="importmap">
  {
    "imports": {
      "react": "https://esm.sh/react@18.3.1"
    }
  }
</script>
<script type="module" src="./app.jsx"></script>
```

```jsx
// app.jsx

import { useState } from "react";

export default function App() {
  return <h1>Hello World!</h1>;
}
```

## JSX Import Source

By default, the extension smartly detects the JSX import source that is defined in the `importmap` script tag. Supported JSX runtime includes:

- react
- preact
- vue
- solid-js
- nano-jsx

You can also specify the JSX runtime by adding a `@jsxRuntime` import in the import map.

```html
<!-- index.html -->

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
