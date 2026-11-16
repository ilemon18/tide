// Vendored Prettier is a pure ESM build with no bundled type declarations.
// Give `*.mjs` a minimal signature here (namespace and default export are both unknown;
// the concrete shape is pinned down in src/lib/prettier.ts).
declare module '*.mjs' {
  const mod: unknown
  export default mod
}
