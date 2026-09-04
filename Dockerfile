# syntax=docker/dockerfile:1
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG NEXT_PUBLIC_PRODUCT_NAME=Spot
ARG NEXT_PUBLIC_PRODUCT_SHORT_NAME=Spot
ARG NEXT_PUBLIC_PRODUCT_TAGLINE="Your agent spots you."
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM node:22-alpine AS run
WORKDIR /app
# The commit this image was built from, echoed by /api/health so a deploy can be
# verified from outside. Declared in this stage only, so bumping it does not
# invalidate the build cache above. Defaults to "dev" for local builds.
ARG APP_BUILD=dev
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 APP_BUILD=$APP_BUILD
COPY --from=build /app/public ./public
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/seed ./seed
EXPOSE 3000
CMD ["node", "server.js"]
