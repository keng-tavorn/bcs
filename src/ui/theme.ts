// The colours CSS cannot reach (FR-PLT-013 AC1): every screen takes its colours from the tokens of src/app/globals.css
// (§9.9, §9.10); these few places are drawn without that stylesheet — the browser's own bar (theme-color) and the PWA
// manifest, the app icons generated as images, and the offline page that renders from the service worker's cache on its
// own. They hold the same values as the tokens of the same name: tests/unit/design-tokens.test.ts compares them with
// globals.css and with the spec's tables. This file and globals.css are the only places a colour may be written
// (bcs/no-color-literal).

/** Token values (§9.9) for places without the stylesheet, by token name */
export const THEME_COLORS = {
  bg: '#ffffff',
  surface: '#f5f7f8',
  line: '#dde3e7',
  ink: '#1c2b33',
  'ink-muted': '#4a5a63',
  primary: '#0b6e5f',
  'on-primary': '#ffffff',
} as const
