import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('monaco-editor') || id.includes('@monaco-editor')) return 'monaco-vendor';
          if (id.includes('dockview')) return 'dockview-vendor';
          if (id.includes('react') || id.includes('react-dom') || id.includes('zustand')) return 'react-vendor';
          // Diagram and terminal libraries load on demand; leave them to dynamic-import splitting so they aren't preloaded.
          if (/mermaid|cytoscape|d3-|dagre|markmap|@xterm/.test(id)) return undefined;
          return 'vendor';
        },
      },
    },
  },
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
  },
});
