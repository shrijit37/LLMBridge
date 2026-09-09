import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  base: "/dashboard/",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  server: {
    port: 5174,
    proxy: {
      "/api": "http://127.0.0.1:7896",
      "/health": "http://127.0.0.1:7896",
      "/stats": "http://127.0.0.1:7896",
      "/v1": "http://127.0.0.1:7896",
    },
  },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 700,
  },
});
