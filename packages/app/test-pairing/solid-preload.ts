// Run from packages/app after `bun install --frozen-lockfile`.
// Scoped workaround for the upstream Bun 1.4.4 hyperscript preload bug.
// Compile the actual Solid DOM implementation without changing repository test configuration.
import { plugin, Glob } from "bun"
import { createRequire } from "node:module"
import { resolve } from "node:path"
const app = createRequire(resolve("package.json"))
const vite = createRequire(app.resolve("vite-plugin-solid"))
const { transformSync } = vite("@babel/core")
const solid = vite("babel-preset-solid")
const root = resolve("../../node_modules/.bun")
const paths = [...new Glob("@babel+preset-typescript@7.27.1*/node_modules/@babel/preset-typescript/lib/index.js").scanSync(root)]
if (paths.length !== 1) throw new Error("Expected the locked Babel TypeScript preset; run the frozen dependency install first")
const typescript = app(resolve(root, paths[0]))
plugin({
  name: "pairing-real-solid-dom",
  setup(build) {
    build.onLoad({ filter: /\.[jt]sx$/ }, async (args) => ({
      contents: transformSync(await Bun.file(args.path).text(), {
        filename: args.path,
        presets: [[solid, { generate: "dom" }], typescript],
        babelrc: false,
        configFile: false,
      }).code,
      loader: "js",
    }))
  },
})
