package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"syscall"
	"time"
)

const (
	gracefulTimeout = 30 * time.Second
	terminateWait   = 10 * time.Second
)

type sessionEvent string

const (
	runnerProcessStarted    sessionEvent = "runner_process_started"
	runnerProcessExited     sessionEvent = "runner_process_exited"
	runnerShutdownStarted   sessionEvent = "runner_shutdown_started"
	runnerShutdownEscalated sessionEvent = "runner_shutdown_escalated"
)

type runnerProcess struct {
	pid  int
	done <-chan error
}

type sessionRuntime interface {
	start(string) (runnerProcess, error)
	signals() (<-chan os.Signal, func())
	signalSession(int, syscall.Signal) error
	wait(<-chan error, time.Duration) (bool, error)
}

func runSession(jitConfig string, runtime sessionRuntime) error {
	process, err := runtime.start(jitConfig)
	if err != nil {
		return fmt.Errorf("start runner: %w", err)
	}
	logEvent(runnerProcessStarted, process.pid, "started", 0)

	signals, stopSignals := runtime.signals()
	defer stopSignals()

	select {
	case err := <-process.done:
		logEvent(runnerProcessExited, process.pid, "exit", exitCode(err))
		return exitResult(err)
	case signal := <-signals:
		logEvent(runnerShutdownStarted, process.pid, signal.String(), 0)
		return shutdown(process, runtime)
	}
}

func shutdown(process runnerProcess, runtime sessionRuntime) error {
	if err := runtime.signalSession(process.pid, syscall.SIGINT); err != nil {
		return err
	}
	if exited, err := runtime.wait(process.done, gracefulTimeout); exited {
		logEvent(runnerProcessExited, process.pid, "sigint", exitCode(err))
		return exitResult(err)
	}
	logEvent(runnerShutdownEscalated, process.pid, "sigterm", 0)
	if err := runtime.signalSession(process.pid, syscall.SIGTERM); err != nil {
		return err
	}
	if exited, err := runtime.wait(process.done, terminateWait); exited {
		logEvent(runnerProcessExited, process.pid, "sigterm", exitCode(err))
		return exitResult(err)
	}
	logEvent(runnerShutdownEscalated, process.pid, "sigkill", 0)
	if err := runtime.signalSession(process.pid, syscall.SIGKILL); err != nil {
		return err
	}
	err := <-process.done
	logEvent(runnerProcessExited, process.pid, "sigkill", exitCode(err))
	return exitResult(err)
}

func logEvent(event sessionEvent, pid int, reason string, code int) {
	record := struct {
		Event    sessionEvent `json:"event"`
		PID      int          `json:"pid"`
		Reason   string       `json:"reason"`
		ExitCode int          `json:"exitCode,omitempty"`
	}{Event: event, PID: pid, Reason: reason, ExitCode: code}
	_ = json.NewEncoder(os.Stdout).Encode(record)
}

type exitCoder interface {
	ExitCode() int
}

func exitCode(err error) int {
	if err == nil {
		return 0
	}
	var coded exitCoder
	if errors.As(err, &coded) {
		return coded.ExitCode()
	}
	return -1
}

func exitResult(err error) error {
	if err == nil {
		return nil
	}
	var coded exitCoder
	if errors.As(err, &coded) {
		return fmt.Errorf("runner exited with status %d", coded.ExitCode())
	}
	return fmt.Errorf("wait for runner: %w", err)
}
