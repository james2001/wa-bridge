import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// Le frontend dev est servi par Vite derrière Caddy (terminaison TLS).
// Le HMR doit donc repasser par Caddy en WSS sur le port public 443.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // On bundle directement la SOURCE TS du contrat partagé: esbuild gère
      // `export *` nativement, alors que rollup ne sait pas analyser les
      // re-exports dynamiques du dist CommonJS (le backend, lui, garde le dist).
      '@app/shared-types': fileURLToPath(
        new URL('../../packages/shared-types/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    host: true,
    port: 5173,
    hmr: {
      protocol: 'wss',
      host: 'app.localhost',
      clientPort: 443,
    },
    // Autorise le Host envoyé par Caddy (protection anti DNS-rebinding de Vite).
    allowedHosts: ['app.localhost', 'localhost', '.localhost'],
  },
});
