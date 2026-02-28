# HAPI Release

Build and release multi-platform binaries for HAPI. Use when asked to "release", "build release", "预编译", "发布", "release binaries".

## Overview

Two products:
- **hapi** (Bun/TypeScript): Full CLI + hub, cross-compiled via `bun build --compile --target`
- **happier** (Rust): Lightweight runner, cross-compiled via `cross` + Docker

## Prerequisites

```bash
# cross (Rust cross-compiler, uses Docker)
cargo install cross --git https://github.com/cross-rs/cross

# nightly toolchain + rust-src (needed for tier-3 targets with build-std)
rustup component add rust-src --toolchain nightly

# Docker wrapper (this machine needs sudo for docker)
cat > /tmp/docker-wrapper.sh << 'SCRIPT'
#!/bin/bash
exec sudo /usr/bin/docker "$@"
SCRIPT
chmod +x /tmp/docker-wrapper.sh
```

## Bun Binaries (hapi)

Targets: `bun-linux-x64`, `bun-darwin-x64`, `bun-darwin-arm64`

```bash
cd /home/kvin/src/hapi

# 1. Build web assets + generate embedded assets
bun run build:web
cd hub && bun run generate:embedded-web-assets && cd ..

# 2. Build each target
bun run build:exe -- --target bun-linux-x64 --with-web-assets
bun run build:exe -- --target bun-darwin-x64 --with-web-assets
bun run build:exe -- --target bun-darwin-arm64 --with-web-assets
```

Output: `cli/dist-exe/<target>/hapi`

Requires tool archives in `cli/tools/archives/` (difftastic, ripgrep per platform).

## Rust Binaries (happier)

### Target Categories

**Tier 2 musl (static, no glibc dependency)** — use `CROSS_REMOTE=1`:
- `x86_64-unknown-linux-musl` — can build with host `cargo` directly (target installed)
- `i686-unknown-linux-musl`
- `aarch64-unknown-linux-musl`
- `arm-unknown-linux-musleabi` — old ARM devices (ARMv5/v6, soft-float)
- `armv7-unknown-linux-musleabihf` — routers, RPi, older Android (ARMv7, hard-float)

**Tier 3 gnu (need glibc on target)** — use `+nightly` + `build-std`:
- `mips-unknown-linux-gnu`
- `mipsel-unknown-linux-gnu`
- `powerpc-unknown-linux-gnu`

### Cross.toml

The file `happier/Cross.toml` configures cross images and build-std. Key points:
- All targets use `image = "ghcr.io/cross-rs/<target>:main"` (default images are too old)
- Tier 3 targets need `build-std = ["std", "panic_abort"]` because rust-std is unavailable
- `panic_abort` is required because `Cargo.toml` sets `panic = "abort"` in release profile

### Build Commands

```bash
cd /home/kvin/src/hapi/happier

# x86_64 musl — host compiler (target already installed)
cargo build --release --target x86_64-unknown-linux-musl

# Tier 2 musl targets — CROSS_REMOTE=1 avoids GLIBC mismatch
# (host Rust build scripts compiled against newer GLIBC can't run in cross container)
for target in i686-unknown-linux-musl aarch64-unknown-linux-musl arm-unknown-linux-musleabi armv7-unknown-linux-musleabihf; do
  CROSS_REMOTE=1 CROSS_CONTAINER_ENGINE=/tmp/docker-wrapper.sh cross build --release --target $target
done

# Tier 3 gnu targets — nightly + build-std (rust-std unavailable for these targets)
for target in mips-unknown-linux-gnu mipsel-unknown-linux-gnu powerpc-unknown-linux-gnu; do
  CROSS_CONTAINER_ENGINE=/tmp/docker-wrapper.sh cross +nightly build --release --target $target
done
```

Output: `happier/target/<target>/release/happier`

### Common Issues

| Problem | Cause | Fix |
|---------|-------|-----|
| `GLIBC_2.xx not found` | Host build scripts need newer GLIBC than container | Use `CROSS_REMOTE=1` (compiles everything inside container) |
| `crtend.o: No such file or directory` | `build-std` + musl = CRT files not found | Don't use `build-std` for musl; use `CROSS_REMOTE=1` instead |
| `can't find crate for panic_abort` | `panic = "abort"` in profile but `panic_abort` not in build-std | Add `"panic_abort"` to `build-std` list |
| `no rust-std ... must use nightly` | Tier 3 target needs build-std which requires nightly | Use `cross +nightly build` |
| `cross does not provide a Docker image` | Target has no official cross image | Use `:main` tag or custom image in Cross.toml |
| `rustup target add` conflict | Stale files from previous cross runs | `rm -rf ~/.rustup/toolchains/stable-*/lib/rustlib/<target>` then re-add |
| `no container engine found` | cross can't find docker | Set `CROSS_CONTAINER_ENGINE=/tmp/docker-wrapper.sh` |

## Packaging & Release

```bash
mkdir -p /tmp/hapi-release && cd /tmp/hapi-release

# Package bun binaries
for target in bun-linux-x64 bun-darwin-x64 bun-darwin-arm64; do
  name=$(echo $target | sed 's/bun-/hapi-/;s/-x64/-x64/;s/-arm64/-arm64/')
  tar czf "${name}.tar.gz" -C /home/kvin/src/hapi/cli/dist-exe/$target hapi
done

# Package Rust binaries
for target_dir in /home/kvin/src/hapi/happier/target/*/release; do
  bin="$target_dir/happier"
  [ -f "$bin" ] || continue
  target=$(basename $(dirname $(dirname "$bin")))
  [ "$target" = "release" ] && continue
  tar czf "happier-${target}.tar.gz" -C "$target_dir" happier
done

# Checksums
sha256sum *.tar.gz > checksums.txt

# Create release
VERSION=v0.15.3-kvin.1  # adjust version
git tag $VERSION && git push origin $VERSION
gh release create $VERSION -t "Release $VERSION" -F notes.md -p -R kvinwang/hapi /tmp/hapi-release/*.tar.gz /tmp/hapi-release/checksums.txt
```

## Target → Use Case Mapping

| Use Case | Rust Target | Linking |
|----------|-------------|---------|
| x86_64 servers/VMs | `x86_64-unknown-linux-musl` | static |
| x86 (32-bit) | `i686-unknown-linux-musl` | static |
| Modern Android / ARM64 routers | `aarch64-unknown-linux-musl` | static |
| ARMv7 routers (OpenWrt), RPi | `armv7-unknown-linux-musleabihf` | static |
| Old ARM devices (ARMv5/v6) | `arm-unknown-linux-musleabi` | static |
| MIPS routers (big-endian) | `mips-unknown-linux-gnu` | dynamic |
| MIPS routers (little-endian) | `mipsel-unknown-linux-gnu` | dynamic |
| PowerPC devices | `powerpc-unknown-linux-gnu` | dynamic |
