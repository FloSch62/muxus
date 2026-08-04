.PHONY: all deb win dmg clean

all:
	pnpm build && pnpm --filter @muxus/electron dist

deb:
	pnpm build && pnpm --filter @muxus/electron exec electron-builder --linux deb --x64

win:
	pnpm build && pnpm --filter @muxus/electron exec electron-builder --win --x64 --arm64

dmg:
	pnpm build && pnpm --filter @muxus/electron exec electron-builder --mac dmg

clean:
	rm -rf electron/release
