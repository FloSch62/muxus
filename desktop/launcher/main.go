// Relay CLI arguments to Bun while retaining the native launcher's platform setup.
package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

func main() {
	executable, err := os.Executable()
	if err != nil {
		os.Exit(1)
	}
	name := "muxus-native"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	command := exec.Command(filepath.Join(filepath.Dir(executable), name), os.Args[1:]...)
	args, err := json.Marshal(os.Args[1:])
	if err != nil {
		os.Exit(1)
	}
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(entry, "MUXUS_LAUNCH_ARGS=") {
			command.Env = append(command.Env, entry)
		}
	}
	command.Env = append(command.Env, "MUXUS_LAUNCH_ARGS="+string(args))
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := command.Run(); err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			os.Exit(exit.ExitCode())
		}
		os.Exit(1)
	}
}
