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
RUN npm install --no-save --package-lock=false playwright@1.58.2
CMD ["node", "client/tests/ui-flow.browser.mjs"]

FROM ui-test AS webcam-test
RUN npm run studio:build
CMD ["node", "client/tests/webcam.browser.mjs"]

FROM docker.io/nginxinc/nginx-unprivileged:stable-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 3000
