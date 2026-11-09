# The memory reading room's image.
#
# Small on purpose, and small for a reason: `pg` is the only runtime dependency this app has, and the extensions in
# this repository are not part of it. `npm ci --omit=dev` therefore installs one package tree, and the Pi packages are
# peer dependencies the UI never imports - which is why the image is a few tens of megabytes rather than the multi-hundred
# megabyte agent image the agents run.
#
# `--omit=dev` also matters for a different reason than size: vitest and its friends are devDependencies here, and an
# image that ships a test runner is an image that invites someone to run it in production.
#
# Build from the repository root, because the lockfile and `ui/` must be in the same context:
#   docker build -f ui/Dockerfile -t initialed85/memory-ui .
FROM docker.io/library/node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY ui/ ./ui/

# 8080 because that is what the Deployment's Service targets and what the Ingress forwards to. Overridable with PORT
# for running it on a laptop without root.
ENV PORT=8080
ENV NODE_ENV=production
EXPOSE 8080

# The unprivileged user the base image already provides. This app reads a Postgres DSN from its environment and serves
# static files; neither needs a uid it cannot get without root.
USER node

# No HEALTHCHECK here: the Deployment defines readiness and liveness, and a container-level default that disagrees with
# the Kubernetes probe is two definitions of health to keep in sync.
CMD ["node", "ui/server.mjs"]
