import { defineConfig } from "tsdown";

export default defineConfig({
  banner: {
    js: "#!/usr/bin/env node",
  },
  clean: true,
  dts: false,
  entry: ["src/index.ts"],
  fixedExtension: false,
  format: ["esm"],
  minify: false,
  platform: "node",
  sourcemap: true,
  target: "node22",
});
