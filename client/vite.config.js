import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Empêche Cloudflare Rocket Loader de réécrire nos <script> (il casse les ES modules :
// `type="module"` devient un type bidon → le bundle n'est jamais exécuté → page blanche).
// `data-cfasync="false"` dit explicitement à Rocket Loader d'ignorer la balise.
function noCloudflareRocketLoader() {
  return {
    name: 'no-cf-rocket-loader',
    transformIndexHtml: {
      order: 'post',
      handler: (html) =>
        html.replace(/<script(?=[\s>])(?![^>]*\bdata-cfasync=)/g, '<script data-cfasync="false"'),
    },
  };
}

export default defineConfig({
  plugins: [react(), noCloudflareRocketLoader()],
  server: {
    port: 5174,
    host: true,
    proxy: {
      '/api': { target: 'http://localhost:4800', changeOrigin: true },
      '/ws': { target: 'ws://localhost:4800', ws: true },
    },
  },
});
