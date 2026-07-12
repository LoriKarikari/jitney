// Command supervisor launches one GitHub Actions JIT runner and owns bounded,
// session-wide shutdown beneath tini.
package main

import (
	"errors"
	"fmt"
	"os"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "jitney supervisor:", err)
		os.Exit(1)
	}
}

func run() error {
	jitConfig := os.Getenv("JIT_CONFIG")
	if jitConfig == "" {
		return errors.New("JIT_CONFIG is required")
	}
	if err := os.Unsetenv("JIT_CONFIG"); err != nil {
		return fmt.Errorf("clear JIT_CONFIG: %w", err)
	}
	return runSession(jitConfig, linuxSession{})
}
