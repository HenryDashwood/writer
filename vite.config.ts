import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port so the native WebView knows where to connect in dev mode.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Tell Vite not to watch Rust build output.
      ignored: ["**/src-tauri/**"],
    },
  },
});
