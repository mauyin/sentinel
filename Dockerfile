# Multi-stage build: Rust risk engine + Node.js runtime

# Stage 1: Build Rust risk engine
FROM rust:1.77-slim AS rust-builder
WORKDIR /build
COPY crates/ crates/
COPY Cargo.toml Cargo.lock* ./
RUN cargo build --release

# Stage 2: Node.js runtime
FROM node:20-slim AS runtime
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy package files and install dependencies
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile --prod 2>/dev/null || pnpm install --prod

# Copy source code
COPY src/ src/
COPY tsconfig.json markets.yaml ./

# Copy pre-built risk engine binary
COPY --from=rust-builder /build/target/release/risk-engine target/release/risk-engine

# Create audit logs directory
RUN mkdir -p audit-logs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

ENTRYPOINT ["npx", "tsx", "src/index.ts"]
CMD ["--mode", "autonomous"]
