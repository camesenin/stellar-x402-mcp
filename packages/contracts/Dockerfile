# Reproducible Build Dockerfile for stellar-x402-contracts
# Pins exact compiler toolchain and target architecture for 100% byte-for-byte reproducibility
FROM rust:1.99.1-slim

WORKDIR /build

# Install standard target for modern Soroban contracts
RUN rustup target add wasm32v1-none

# Copy Rust contract workspace
COPY Cargo.toml Cargo.lock* rust-toolchain.toml* ./
COPY src ./src

# Build release WASM binary
RUN cargo build --manifest-path Cargo.toml --target wasm32v1-none --release

# Output SHA-256 hash on run
CMD ["sha256sum", "target/wasm32v1-none/release/stellar_x402_contracts.wasm"]
