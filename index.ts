/**
 * Root entry for `.opencode/plugins/` auto-discovery.
 *
 * OpenCode's auto-discovery loads `.opencode/plugins/<name>/index.ts`,
 * while the `plugins` config array loads the package export. This file
 * makes both work from the same checkout.
 */

export { default } from "./src/index.ts"
