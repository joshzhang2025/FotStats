/** Replaced at build time by esbuild's `define`. False in production builds. */
declare const __DEV__: boolean;

/**
 * Stylesheets imported by the overlay arrive as strings (esbuild's `text`
 * loader), because a content script cannot fetch an extension URL without
 * declaring web_accessible_resources — which we deliberately do not.
 */
declare module '*.css' {
  const css: string;
  export default css;
}
