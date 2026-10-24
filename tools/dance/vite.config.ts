import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { poseAssetsPlugin } from '../../scripts/poseAssets.ts';

// The Studio (index.html) and the headless renderer the CLI drives (render.html). The bridge
// (server.ts) serves them with this config in middleware mode, or the build from dist/.
export default defineConfig({
  root: fileURLToPath(new URL('./studio', import.meta.url)),
  plugins: [react(), poseAssetsPlugin()],
  resolve: { dedupe: ['react', 'react-dom', 'three', '@react-three/fiber'] },
  // Pre-bundle everything both pages need up front: a dependency found later makes Vite reload
  // the page, which a headless render would have to wait out. Only the pose worker imports
  // MediaPipe, and Vite's dependency scan doesn't follow workers.
  optimizeDeps: {
    entries: ['index.html', 'render.html'],
    include: ['@mediapipe/tasks-vision', 'react', 'react-dom/client', 'react/jsx-runtime', 'three', '@react-three/fiber',
      'three/addons/environments/RoomEnvironment.js', 'three/addons/loaders/GLTFLoader.js', 'three/addons/utils/SkeletonUtils.js',
      'three/addons/postprocessing/EffectComposer.js', 'three/addons/postprocessing/RenderPass.js', 'three/addons/postprocessing/UnrealBloomPass.js',
      'three/addons/postprocessing/ShaderPass.js', 'three/addons/postprocessing/OutputPass.js'],
  },
  server: { fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] } },
  build: {
    outDir: '../dist', emptyOutDir: true, chunkSizeWarningLimit: 4000,
    rolldownOptions: {
      input: {
        studio: fileURLToPath(new URL('./studio/index.html', import.meta.url)),
        render: fileURLToPath(new URL('./studio/render.html', import.meta.url)),
      },
    },
  },
});
