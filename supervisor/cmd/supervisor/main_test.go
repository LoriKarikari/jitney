package main

import (
	"os"
	"strings"
	"testing"
)

func TestRunRequiresJITConfig(t *testing.T) {
	t.Setenv("JIT_CONFIG", "")
	if err := run(); err == nil || err.Error() != "JIT_CONFIG is required" {
		t.Fatalf("run() error = %v, want required-config error", err)
	}
}

func TestRunClearsJITConfigBeforeStartingRunner(t *testing.T) {
	const canary = "jit-config-canary-must-not-leak"
	t.Setenv("JIT_CONFIG", canary)

	err := run()
	if err == nil {
		t.Fatal("run() error = nil, want missing runner script error")
	}
	if strings.Contains(err.Error(), canary) {
		t.Fatalf("run() error exposed JIT config: %v", err)
	}
	if _, present := os.LookupEnv("JIT_CONFIG"); present {
		t.Fatal("JIT_CONFIG remains in supervisor environment")
	}
}
