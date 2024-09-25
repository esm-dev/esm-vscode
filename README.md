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
      "@jsxRuntime": "https://esm.sh/react@18.3.1",
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

> The `@jsxRuntime` is a special field for JSX runtime resloving. It's not required if you don't use it.
