//go:build unix

package history

import (
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

// statfsBytes mirrors statfsSync: bavail*bsize free, blocks*bsize total.
func statfsBytes(path string) (free, total int64, err error) {
	var stat unix.Statfs_t
	if err := unix.Statfs(path, &stat); err != nil {
		return 0, 0, err
	}
	return int64(stat.Bavail) * int64(stat.Bsize), int64(stat.Blocks) * int64(stat.Bsize), nil
}

// fileAllocatedSize mirrors the Node worker's usage accounting: POSIX
// st_blocks measures allocated 512-byte units (including sparse files
// accurately).
func fileAllocatedSize(info os.FileInfo) int64 {
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		return int64(stat.Blocks) * 512
	}
	return info.Size()
}
