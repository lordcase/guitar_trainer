import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

// `npm run dev` — plain http://localhost for laptop debugging.
// `npm run dev:mobile` — https + LAN host so getUserMedia works on a phone
// (mic access requires a secure context off-localhost; accept the
// self-signed cert warning once on the phone).
export default defineConfig({
  plugins: process.env.HTTPS ? [basicSsl()] : [],
  server: {
    port: 5151,
    strictPort: true,
  },
})
