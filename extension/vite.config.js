import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  root, base: "./", publicDir: path.join(root, "public"),
  build: {
    outDir: path.resolve(root, "../dist/extension-unpacked"),
    emptyOutDir: true, sourcemap: false,
    rollupOptions: {
      input: {
        offscreen: path.resolve(root, "offscreen.html"),
        permission: path.resolve(root, "permission.html"),
        popup: path.resolve(root, "popup.html")
      }
    }
  }
});
