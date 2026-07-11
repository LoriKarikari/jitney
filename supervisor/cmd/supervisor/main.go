// Command supervisor launches one GitHub Actions JIT runner and owns bounded,
// session-wide shutdown beneath tini.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"
)

const (
	runnerScript    = "/home/runner/run.sh"
	gracefulTimeout = 30 * time.Second
	terminateWait   = 10 * time.Second
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

	// #nosec G204,G702 -- executable and argument positions are fixed; JIT config is opaque data, not shell input.
	cmd := exec.Command(runnerScript, "--jitconfig", jitConfig)
	cmd.Env = os.Environ()
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start runner: %w", err)
	}
	logEvent("runner_process_started", cmd.Process.Pid, "started", 0)
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(signals)

	select {
	case err := <-done:
		logEvent("runner_process_exited", cmd.Process.Pid, "exit", exitCode(err))
		return exitResult(err)
	case signal := <-signals:
		logEvent("runner_shutdown_started", cmd.Process.Pid, signal.String(), 0)
		return shutdown(cmd.Process.Pid, done)
	}
}

func shutdown(pid int, done <-chan error) error {
	if err := signalSession(pid, syscall.SIGINT); err != nil {
		return err
	}
	if exited, err := wait(done, gracefulTimeout); exited {
		logEvent("runner_process_exited", pid, "sigint", exitCode(err))
		return exitResult(err)
	}
	logEvent("runner_shutdown_escalated", pid, "sigterm", 0)
	if err := signalSession(pid, syscall.SIGTERM); err != nil {
		return err
	}
	if exited, err := wait(done, terminateWait); exited {
		logEvent("runner_process_exited", pid, "sigterm", exitCode(err))
		return exitResult(err)
	}
	logEvent("runner_shutdown_escalated", pid, "sigkill", 0)
	if err := signalSession(pid, syscall.SIGKILL); err != nil {
		return err
	}
	err := <-done
	logEvent("runner_process_exited", pid, "sigkill", exitCode(err))
	return exitResult(err)
}

func logEvent(event string, pid int, reason string, code int) {
	record := struct {
		Event    string `json:"event"`
		PID      int    `json:"pid"`
		Reason   string `json:"reason"`
		ExitCode int    `json:"exitCode,omitempty"`
	}{Event: event, PID: pid, Reason: reason, ExitCode: code}
	_ = json.NewEncoder(os.Stdout).Encode(record)
}

func exitCode(err error) int {
	if err == nil {
		return 0
	}
	var exitError *exec.ExitError
	if errors.As(err, &exitError) {
		return exitError.ExitCode()
	}
	return -1
}

func signalSession(pid int, sig syscall.Signal) error {
	if err := syscall.Kill(-pid, sig); err != nil && !errors.Is(err, syscall.ESRCH) {
		return fmt.Errorf("signal runner session with %s: %w", sig, err)
	}
	return nil
}

func wait(done <-chan error, timeout time.Duration) (bool, error) {
	select {
	case err := <-done:
		return true, err
	case <-time.After(timeout):
		return false, nil
	}
}

func exitResult(err error) error {
	if err == nil {
		return nil
	}
	var exitError *exec.ExitError
	if errors.As(err, &exitError) {
		return fmt.Errorf("runner exited with status %d", exitError.ExitCode())
	}
	return fmt.Errorf("wait for runner: %w", err)
}
