import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      rollupOptions: {
        /*
         * Duas entradas. Sem declarar `auth/redirect.html` aqui, o Vite
         * empacotaria apenas o index e a ponte de redirect do MSAL sumiria do
         * build — o login funcionaria em `npm run dev` e quebraria em produção.
         *
         * A página é servida como arquivo estático em /auth/redirect.html, sem
         * depender de rewrite no servidor: mesma URL em dev, preview e build.
         */
        input: {
          main: path.resolve(__dirname, 'index.html'),
          authRedirect: path.resolve(__dirname, 'auth/redirect.html'),
        },
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
