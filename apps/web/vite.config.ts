import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
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
  };
});
