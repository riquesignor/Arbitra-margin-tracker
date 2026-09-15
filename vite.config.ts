import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    // SheetJS (xlsx) será adicionado via CDN da SheetJS quando o parser Excel
    // entrar (ver README > Riscos conhecidos). Isolar em chunk próprio evita
    // que o bundle principal pague o custo de libs pesadas carregadas sob demanda.
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom"],
        },
      },
    },
  },
});

