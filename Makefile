.PHONY: all build package test clean

all: build

build:
	pnpm build

package:
	pnpm package

test:
	pnpm typecheck
	pnpm lint
	pnpm test
	pnpm test:go

clean:
	rm -rf build client/dist shared/dist
