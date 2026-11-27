import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

function loadOptionalHttps() {
  if (process.env.GEET_HTTPS !== "1") return undefined;
  const certDir = path.resolve(__dirname, "../../.cert");
  const keyPath = path.join(certDir, "key.pem");
  const certPath = path.join(certDir, "cert.pem");
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }
  return undefined;
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    https: loadOptionalHttps(),
    proxy: {
      "/lan-api": {
        target: "http://127.0.0.1:8765",
        changeOrigin: true,
        ws: true,
        rewrite: (p) => p.replace(/^\/lan-api/, "/lan"),
      },
    },
  },
});
