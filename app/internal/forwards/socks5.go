package forwards

import (
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"strconv"
)

// Just enough SOCKS5 (RFC 1928) to serve browsers and CLIs: no-auth
// negotiation, then a CONNECT request with IPv4/domain/IPv6 target. Port of
// socks5Connect in forward-manager.ts.

func socksFail(socket net.Conn, code byte) {
	// VER REP RSV ATYP BND.ADDR BND.PORT — reply with the error, then hang up.
	_, _ = socket.Write([]byte{5, code, 0, 1, 0, 0, 0, 0, 0, 0})
	_ = socket.Close()
}

func readFull(socket net.Conn, buffer []byte) bool {
	_, err := io.ReadFull(socket, buffer)
	return err == nil
}

func serveSocks5(socket net.Conn, open func(host string, port int) (net.Conn, error)) {
	defer socket.Close()

	greeting := make([]byte, 2)
	if !readFull(socket, greeting) || greeting[0] != 5 {
		return
	}
	methods := make([]byte, int(greeting[1]))
	if !readFull(socket, methods) {
		return
	}
	noAuth := false
	for _, method := range methods {
		if method == 0 {
			noAuth = true
			break
		}
	}
	if !noAuth {
		_, _ = socket.Write([]byte{5, 0xff})
		return
	}
	if _, err := socket.Write([]byte{5, 0}); err != nil {
		return
	}

	request := make([]byte, 4)
	if !readFull(socket, request) {
		return
	}
	if request[0] != 5 || request[1] != 1 {
		socksFail(socket, 7)
		return
	}

	var host string
	switch request[3] {
	case 1:
		address := make([]byte, net.IPv4len)
		if !readFull(socket, address) {
			return
		}
		host = net.IP(address).String()
	case 3:
		length := make([]byte, 1)
		if !readFull(socket, length) {
			return
		}
		address := make([]byte, int(length[0]))
		if !readFull(socket, address) {
			return
		}
		host = string(address)
	case 4:
		address := make([]byte, net.IPv6len)
		if !readFull(socket, address) {
			return
		}
		host = net.IP(address).String()
	default:
		socksFail(socket, 8)
		return
	}
	portBytes := make([]byte, 2)
	if !readFull(socket, portBytes) {
		return
	}
	port := int(binary.BigEndian.Uint16(portBytes))
	stream, err := open(host, port)
	if err != nil {
		socksFail(socket, 5)
		return
	}
	defer stream.Close()
	if _, err := socket.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0}); err != nil {
		return
	}
	pipe(socket, stream)
}

func socksAddress(host string, port int) string {
	return net.JoinHostPort(host, strconv.Itoa(port))
}

func socksError(host string, port int, err error) error {
	return fmt.Errorf("SOCKS connect %s: %w", socksAddress(host, port), err)
}
