package forwards

import (
	"encoding/binary"
	"io"
	"net"
	"testing"
)

func TestSocks5ConnectNegotiationAndDataPath(t *testing.T) {
	client, server := net.Pipe()
	targetClient, targetServer := net.Pipe()
	t.Cleanup(func() {
		_ = client.Close()
		_ = targetClient.Close()
		_ = targetServer.Close()
	})
	var gotHost string
	var gotPort int
	go serveSocks5(server, func(host string, port int) (net.Conn, error) {
		gotHost, gotPort = host, port
		return targetClient, nil
	})

	if _, err := client.Write([]byte{5, 1, 0}); err != nil {
		t.Fatal(err)
	}
	method := make([]byte, 2)
	if _, err := io.ReadFull(client, method); err != nil {
		t.Fatal(err)
	}
	if method[0] != 5 || method[1] != 0 {
		t.Fatalf("method response = %v", method)
	}
	host := []byte("service.internal")
	request := []byte{5, 1, 0, 3, byte(len(host))}
	request = append(request, host...)
	var port [2]byte
	binary.BigEndian.PutUint16(port[:], 8443)
	request = append(request, port[:]...)
	if _, err := client.Write(request); err != nil {
		t.Fatal(err)
	}
	response := make([]byte, 10)
	if _, err := io.ReadFull(client, response); err != nil {
		t.Fatal(err)
	}
	if response[1] != 0 || gotHost != "service.internal" || gotPort != 8443 {
		t.Fatalf("response=%v target=%s:%d", response, gotHost, gotPort)
	}

	go func() {
		buffer := make([]byte, 4)
		_, _ = io.ReadFull(targetServer, buffer)
		_, _ = targetServer.Write(buffer)
	}()
	if _, err := client.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	reply := make([]byte, 4)
	if _, err := io.ReadFull(client, reply); err != nil {
		t.Fatal(err)
	}
	if string(reply) != "ping" {
		t.Fatalf("reply = %q", reply)
	}
}
