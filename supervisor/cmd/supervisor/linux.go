package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"
)

const runnerScript = "/home/runner/run.sh"

type linuxSession struct{}

func (linuxSession) start(jitConfig string) (runnerProcess, error) {
	// #nosec G204,G702 -- executable and argument positions are fixed; JIT config is opaque data, not shell input.
	cmd := exec.Command(runnerScript, "--jitconfig", jitConfig)
	cmd.Env = os.Environ()
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return runnerProcess{}, err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	return runnerProcess{pid: cmd.Process.Pid, done: done}, nil
}

func (linuxSession) signals() (<-chan os.Signal, func()) {
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	return signals, func() { signal.Stop(signals) }
}

func (linuxSession) signalSession(pid int, sig syscall.Signal) error {
	if err := syscall.Kill(-pid, sig); err != nil && !errors.Is(err, syscall.ESRCH) {
		return fmt.Errorf("signal runner session with %s: %w", sig, err)
	}
	return nil
}

func (linuxSession) wait(done <-chan error, timeout time.Duration) (bool, error) {
	select {
	case err := <-done:
		return true, err
	case <-time.After(timeout):
		return false, nil
	}
}
