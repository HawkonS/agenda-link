FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build
FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production AGENDA_LINK_WORKSPACE=/state
RUN mkdir /state && chown node:node /state
USER node
VOLUME ["/state"]
EXPOSE 15173
CMD ["/bin/bash", "/app/run.sh", "--no-build"]
