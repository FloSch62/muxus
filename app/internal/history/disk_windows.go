//go:build windows

package history

import (
	"os"

	"golang.org/x/sys/windows"
)

func statfsBytes(path string) (free, total int64, err error) {
	var freeBytesAvailable, totalBytes, totalFreeBytes uint64
	pathPtr, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, 0, err
	}
	if err := windows.GetDiskFreeSpaceEx(pathPtr, &freeBytesAvailable, &totalBytes, &totalFreeBytes); err != nil {
		return 0, 0, err
	}
	return int64(freeBytesAvailable), int64(totalBytes), nil
}

// Windows has no st_blocks; logical size is the Node fallback too.
func fileAllocatedSize(info os.FileInfo) int64 {
	return info.Size()
}
