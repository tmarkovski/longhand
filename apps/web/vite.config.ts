import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Served at the domain root (trylonghand.com via CNAME), not /<repo>/.
  base: "/",
});
