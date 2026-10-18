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

# Phone pairing (the `pairing` Compose service): introduces a game to a phone for WebRTC.
# It needs only Node and its own folder.
FROM node:24-alpine AS pairing
WORKDIR /app
COPY package.json ./
COPY packages/pairing ./packages/pairing
USER node
EXPOSE 3001
CMD ["node", "packages/pairing/main.ts"]

FROM docker.io/nginxinc/nginx-unprivileged:stable-alpine
# A template: the image's entrypoint fills in the DNS resolver and the pairing upstream.
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY --chmod=755 pairing-upstream.envsh /docker-entrypoint.d/05-pairing-upstream.envsh
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 3000
