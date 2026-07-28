package telnetx

import (
	"bytes"
	"io"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/FloSch62/muxus/app/internal/api"
)

const testTimeout = 5 * time.Second

func TestTransportPreservesBannerAndCarriesInputOverTCP(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	var mu sync.Mutex
	var fromClient []byte
	inputReceived := make(chan struct{})
	var once sync.Once
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = conn.Write(append([]byte{iac, will, optEcho}, "login:"...))
		buf := make([]byte, 4096)
		for {
			n, err := conn.Read(buf)
			if n > 0 {
				mu.Lock()
				fromClient = append(fromClient, buf[:n]...)
				seen := bytes.Contains(fromClient, []byte("admin\r\n"))
				mu.Unlock()
				if seen {
					once.Do(func() { close(inputReceived) })
				}
			}
			if err != nil {
				return
			}
		}
	}()

	port := ln.Addr().(*net.TCPAddr).Port
	transport, err := Connect(&api.TelnetProfile{Kind: "telnet", Host: "127.0.0.1", Port: port}, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer transport.Close()

	banner := make(chan []byte, 1)
	go func() {
		var chunks []byte
		buf := make([]byte, 4096)
		for {
			n, err := transport.Read(buf)
			if n > 0 {
				chunks = append(chunks, buf[:n]...)
				if bytes.Contains(chunks, []byte("login:")) {
					banner <- chunks
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()
	select {
	case got := <-banner:
		if !bytes.Contains(got, []byte("login:")) {
			t.Fatalf("banner %q does not contain login prompt", got)
		}
	case <-time.After(testTimeout):
		t.Fatal("timed out waiting for banner")
	}

	if _, err := transport.Write([]byte("admin\r")); err != nil {
		t.Fatal(err)
	}
	select {
	case <-inputReceived:
	case <-time.After(testTimeout):
		t.Fatal("timed out waiting for input on the server side")
	}

	mu.Lock()
	wire := append([]byte(nil), fromClient...)
	mu.Unlock()
	if !bytes.Contains(wire, []byte{iac, do, optEcho}) {
		t.Fatalf("wire %v missing IAC DO ECHO reply", wire)
	}
	if !bytes.Contains(wire, []byte("admin\r\n")) {
		t.Fatalf("wire %v missing NVT-translated input", wire)
	}
}

// The ws layer relies on Read returning io.EOF for a clean remote close, and
// the codec must flush a held-back trailing CR before that EOF.
func TestTransportReadReturnsEOFOnCleanServerClose(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		_, _ = conn.Write([]byte{'b', 'y', 'e', 13})
		conn.Close()
	}()

	port := ln.Addr().(*net.TCPAddr).Port
	transport, err := Connect(&api.TelnetProfile{Kind: "telnet", Host: "127.0.0.1", Port: port}, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer transport.Close()

	type result struct {
		data []byte
		err  error
	}
	done := make(chan result, 1)
	go func() {
		data, err := io.ReadAll(transport)
		done <- result{data, err}
	}()
	select {
	case r := <-done:
		if r.err != nil {
			t.Fatalf("ReadAll error: %v", r.err)
		}
		if !bytes.Equal(r.data, []byte{'b', 'y', 'e', 13}) {
			t.Fatalf("data = %v, want trailing CR flushed before EOF", r.data)
		}
	case <-time.After(testTimeout):
		t.Fatal("timed out waiting for EOF")
	}
}
