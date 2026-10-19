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
CMD ["node", "client/tests/ui-flow.browser.ts"]

FROM ui-test AS webcam-test
RUN npm run studio:build
CMD ["sh", "-c", "node client/tests/webcam.browser.ts && node client/tests/webcam-calibration.browser.ts && node client/tests/phone.browser.ts"]

FROM docker.io/nginxinc/nginx-unprivileged:stable-alpine
# Phone pairing runs in this container beside nginx: Node from the build image (the same
# Alpine) and the pairing server's own folder.
USER root
RUN apk add --no-cache libstdc++
USER 101
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY package.json /app/
COPY packages/pairing /app/packages/pairing
COPY --chmod=755 pairing-start.sh /docker-entrypoint.d/05-pairing.sh
ENV PAIRING_HOST=127.0.0.1
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 3000
