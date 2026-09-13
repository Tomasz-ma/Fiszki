import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base musi odpowiadać nazwie repozytorium przy publikacji na GitHub Pages
// (https://<user>.github.io/<repo>/) — jeśli nazwa repo się zmieni, zmień tu.
export default defineConfig({
  plugins: [react()],
  base: '/Fiszki/',
});
