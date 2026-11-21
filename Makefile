.PHONY: all deb win dmg clean

all:
	pnpm build && pnpm --filter @muxus/electron dist

deb:
	pnpm build && pnpm --filter @muxus/electron exec electron-builder --linux deb --x64

# An installer for two CPUs carries one SSH engine binary for each; the Rust
# targets need `rustup target add` once.
win: export MUXUS_ENGINE_TARGETS = x86_64-pc-windows-msvc,aarch64-pc-windows-msvc
win:
	pnpm build && pnpm --filter @muxus/electron exec electron-builder --win --x64 --arm64

dmg: export MUXUS_ENGINE_TARGETS = aarch64-apple-darwin,x86_64-apple-darwin
dmg:
	pnpm build && pnpm --filter @muxus/electron exec electron-builder --mac dmg

clean:
	rm -rf electron/release
