import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { poseAssetsPlugin } from '../../scripts/poseAssets.ts';
export default defineConfig({
  root: fileURLToPath(new URL("./web", import.meta.url)),
  plugins: [react(), poseAssetsPlugin()],
  resolve: { dedupe: ["react", "react-dom", "three", "@react-three/fiber"] },
  // The pose worker's MediaPipe import is invisible to Vite's dependency scan; see vite.config.ts.
  optimizeDeps: { include: ["@mediapipe/tasks-vision"] },
  build: { outDir: "../dist", emptyOutDir: true },
  server: { port: 5177 },
  preview: { port: 8082 },
});
