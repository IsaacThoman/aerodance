FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run studio:build

FROM build AS test
RUN npm test && npm run studio:test

FROM mcr.microsoft.com/playwright:v1.58.2-noble AS ui-test
WORKDIR /app
COPY --from=build /app ./
CMD ["sh", "-c", "node tools/choreography/tests/browser-storage.browser.ts && node tools/choreography/tests/browser.ts && node tools/choreography/tests/video-import.browser.ts && node tools/choreography/tests/solo-workflow.browser.ts && node tools/choreography/tests/video-duet.browser.ts && node tools/choreography/tests/project-loading.browser.ts"]

FROM docker.io/nginxinc/nginx-unprivileged:stable-alpine AS runtime
COPY tools/choreography/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/tools/choreography/dist /usr/share/nginx/html
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:3000/ || exit 1
