import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
await build({ entryPoints: ["src/renderer/app.js"], bundle: true, minify: true, format: "iife", outfile: "dist/app.js" });
for (const file of ["index.html", "style.css"]) copyFileSync(`src/renderer/${file}`, `dist/${file}`);
