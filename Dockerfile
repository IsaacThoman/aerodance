FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM build AS test
RUN npm test

FROM mcr.microsoft.com/playwright:v1.58.2-noble AS ui-test
WORKDIR /app
COPY --from=build /app ./
CMD ["sh", "-c", "node apps/web/tests/remote.browser.ts && node apps/web/tests/ui-flow.browser.ts && UI_ASPECT=standard node apps/web/tests/ui-flow.browser.ts && node apps/web/tests/custom-songs.browser.ts && node apps/web/tests/transfer-songs.browser.ts && TRANSFER_TRANSPORT=relay node apps/web/tests/transfer-songs.browser.ts"]

FROM ui-test AS webcam-test
RUN npm run studio:build
CMD ["sh", "-c", "node apps/web/tests/webcam.browser.ts && node apps/web/tests/webcam-calibration.browser.ts && node apps/web/tests/phone.browser.ts"]

FROM docker.io/nginxinc/nginx-unprivileged:stable-alpine
# Phone pairing runs in this container beside nginx: Node from the build image (the same
# Alpine), the pairing server's own folder and ws, its one dependency (for the relay).
USER root
RUN apk add --no-cache libstdc++
USER 101
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY package.json /app/
COPY packages/pairing /app/packages/pairing
COPY --from=build /app/node_modules/ws /app/node_modules/ws
COPY --chmod=755 pairing-start.sh /docker-entrypoint.d/05-pairing.sh
ENV PAIRING_HOST=127.0.0.1
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 3000
