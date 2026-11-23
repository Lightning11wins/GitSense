import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { host: "127.0.0.1" },
  // Tauri loads the bundle from disk, so large chunks cost no download time.
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
});
