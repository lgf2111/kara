/// <reference types="vite/client" />

/** CSS imported with `?inline` is bundled as a string, never fetched. */
declare module '*.css?inline' {
  const css: string;
  export default css;
}
