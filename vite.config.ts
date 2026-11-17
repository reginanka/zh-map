import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';
import {VitePWA} from 'vite-plugin-pwa';

export default defineConfig(() => {
  return {
    base: './',
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        devOptions: {
          enabled: false,
        },
        includeAssets: ['favicon.ico', 'icons/favicon-32.png', 'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png'],
        manifest: {
          id: './',
          name: 'Мапа відключень — Житомирська область',
          short_name: 'Світло ЖТ',
          description: 'Інтерактивна мапа відключень електроенергії Житомирської області',
          start_url: './',
          scope: './',
          display: 'standalone',
          theme_color: '#06080e',
          background_color: '#06080e',
          lang: 'uk',
          icons: [
            {
              src: './icons/icon-192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: './icons/icon-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: './icons/icon-512-maskable.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          cleanupOutdatedCaches: true,
          clientsClaim: true,
          skipWaiting: true,
          maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
          globPatterns: ['**/*.{js,mjs,css,html,ico,png,svg,geojson}'],
          globIgnores: ['**/data/outages*.json'],
          runtimeCaching: [
            {
              urlPattern: /data\/outages\.json/,
              handler: 'NetworkFirst',
              options: {
                cacheName: 'outages-data',
                networkTimeoutSeconds: 6,
                fetchOptions: {
                  cache: 'no-store',
                },
                matchOptions: {
                  ignoreSearch: true,
                },
                cacheableResponse: {
                  statuses: [200],
                },
                expiration: {
                  maxEntries: 2,
                  maxAgeSeconds: 60 * 60 * 24,
                },
              },
            },
          ],
        },
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, '.'),
      },
    },
    optimizeDeps: {
      exclude: ['maplibre-gl'],
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
