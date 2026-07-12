package main

import (
	"errors"
	"os"
	"reflect"
	"syscall"
	"testing"
	"time"
)

type waitResult struct {
	exited bool
	err    error
}

type fakeSession struct {
	process     runnerProcess
	done        chan error
	signalInput chan os.Signal
	waits       []waitResult
	sent        []syscall.Signal
	startConfig string
	stopped     bool
	signalErr   error
}

func newFakeSession() *fakeSession {
	done := make(chan error, 1)
	return &fakeSession{
		process:     runnerProcess{pid: 42, done: done},
		done:        done,
		signalInput: make(chan os.Signal, 1),
	}
}

func (fake *fakeSession) start(config string) (runnerProcess, error) {
	fake.startConfig = config
	return fake.process, nil
}

func (fake *fakeSession) signals() (<-chan os.Signal, func()) {
	return fake.signalInput, func() { fake.stopped = true }
}

func (fake *fakeSession) signalSession(_ int, signal syscall.Signal) error {
	fake.sent = append(fake.sent, signal)
	return fake.signalErr
}

func (fake *fakeSession) wait(_ <-chan error, _ time.Duration) (bool, error) {
	result := fake.waits[0]
	fake.waits = fake.waits[1:]
	return result.exited, result.err
}

func TestRunSessionReturnsRunnerExit(t *testing.T) {
	fake := newFakeSession()
	fake.done <- nil

	if err := runSession("jit-config", fake); err != nil {
		t.Fatalf("runSession() error = %v", err)
	}
	if fake.startConfig != "jit-config" {
		t.Fatalf("start config = %q, want jit-config", fake.startConfig)
	}
	if !fake.stopped {
		t.Fatal("signal notifications were not stopped")
	}
}

func TestShutdownStopsAfterSIGINT(t *testing.T) {
	fake := newFakeSession()
	fake.waits = []waitResult{{exited: true}}

	if err := shutdown(fake.process, fake); err != nil {
		t.Fatalf("shutdown() error = %v", err)
	}
	if !reflect.DeepEqual(fake.sent, []syscall.Signal{syscall.SIGINT}) {
		t.Fatalf("signals = %v, want [SIGINT]", fake.sent)
	}
}

func TestShutdownEscalatesThroughSIGKILL(t *testing.T) {
	fake := newFakeSession()
	fake.waits = []waitResult{{exited: false}, {exited: false}}
	fake.done <- nil

	if err := shutdown(fake.process, fake); err != nil {
		t.Fatalf("shutdown() error = %v", err)
	}
	want := []syscall.Signal{syscall.SIGINT, syscall.SIGTERM, syscall.SIGKILL}
	if !reflect.DeepEqual(fake.sent, want) {
		t.Fatalf("signals = %v, want %v", fake.sent, want)
	}
}

func TestShutdownReturnsSignalFailure(t *testing.T) {
	fake := newFakeSession()
	fake.signalErr = errors.New("signal failed")

	if err := shutdown(fake.process, fake); !errors.Is(err, fake.signalErr) {
		t.Fatalf("shutdown() error = %v, want signal failure", err)
	}
}
