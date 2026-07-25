FROM node:22-slim

WORKDIR /app

# Install pnpm globally (avoid corepack which fails in Railway build env)
RUN npm install -g pnpm@9.15.9

# Copy workspace config files first for better layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./

# Copy all package.json files so pnpm can resolve the workspace graph
COPY artifacts/api-server/package.json ./artifacts/api-server/
COPY artifacts/zora-sniper/package.json ./artifacts/zora-sniper/
COPY lib/api-client-react/package.json ./lib/api-client-react/
COPY lib/api-spec/package.json ./lib/api-spec/
COPY lib/api-zod/package.json ./lib/api-zod/
COPY lib/db/package.json ./lib/db/
COPY scripts/package.json ./scripts/

# Install all dependencies
RUN pnpm install --frozen-lockfile

# Copy full source
COPY . .

# Build: codegen → frontend → backend
RUN pnpm --filter @workspace/api-spec run codegen && \
    pnpm --filter @workspace/zora-sniper run build && \
    pnpm --filter @workspace/api-server run build

EXPOSE 3000

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
