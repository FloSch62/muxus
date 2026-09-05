.PHONY: all deb win dmg clean

all:
	pnpm build && pnpm --filter @muxus/desktop dist

deb: all
	pnpm --filter @muxus/desktop deb

win: all

dmg: all

clean:
	rm -rf desktop/build desktop/artifacts
