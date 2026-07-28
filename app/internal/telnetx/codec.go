// Package telnetx implements the Telnet terminal transport, porting
// server/src/telnet/telnet-transport.ts: option negotiation (binary, echo,
// suppress-go-ahead, terminal-type, NAWS) plus NVT newline translation.
package telnetx

// Telnet protocol bytes (RFC 854/855).
const (
	iac  = 255
	dont = 254
	do   = 253
	wont = 252
	will = 251
	sb   = 250
	se   = 240

	optBinary          = 0
	optEcho            = 1
	optSuppressGoAhead = 3
	optTerminalType    = 24
	optNAWS            = 31

	terminalTypeIs   = 0
	terminalTypeSend = 1
)

const defaultTerminalType = "xterm-256color"

type parserState int

const (
	stateData parserState = iota
	stateIAC
	stateOption
	stateSBOption
	stateSBData
	stateSBIAC
)

// Codec is an incremental Telnet codec. Negotiation bytes are consumed and
// answered, while application bytes are emitted for xterm. State deliberately
// spans TCP chunks because IAC commands and sub-negotiations can be
// fragmented at any byte boundary.
type Codec struct {
	cols, rows int
	send       func([]byte)
	receive    func([]byte)

	state         parserState
	command       byte
	subOption     byte
	subData       []byte
	remoteEnabled map[byte]bool
	localEnabled  map[byte]bool
	pendingCr     bool
}

func NewCodec(cols, rows int, send, receive func([]byte)) *Codec {
	return &Codec{
		cols:          cols,
		rows:          rows,
		send:          send,
		receive:       receive,
		remoteEnabled: make(map[byte]bool),
		localEnabled:  make(map[byte]bool),
	}
}

func (c *Codec) Feed(chunk []byte) {
	var output []byte
	for _, b := range chunk {
		switch c.state {
		case stateData:
			if b == iac {
				c.state = stateIAC
			} else {
				output = c.pushApplicationByte(b, output)
			}
		case stateIAC:
			switch {
			case b == iac:
				output = c.pushApplicationByte(iac, output)
				c.state = stateData
			case b == will || b == wont || b == do || b == dont:
				c.command = b
				c.state = stateOption
			case b == sb:
				c.state = stateSBOption
			default:
				// NOP, GA, AYT and other two-byte commands carry no terminal data.
				c.state = stateData
			}
		case stateOption:
			c.negotiate(c.command, b)
			c.state = stateData
		case stateSBOption:
			c.subOption = b
			c.subData = nil
			c.state = stateSBData
		case stateSBData:
			if b == iac {
				c.state = stateSBIAC
			} else {
				c.subData = append(c.subData, b)
			}
		case stateSBIAC:
			if b == iac {
				c.subData = append(c.subData, iac)
				c.state = stateSBData
			} else if b == se {
				c.subnegotiate(c.subOption, c.subData)
				c.state = stateData
			} else {
				// Malformed sub-negotiation: discard it and resynchronize.
				c.state = stateData
			}
		}
	}
	if len(output) > 0 {
		c.receive(output)
	}
}

// Encode prepares terminal input for the wire: IAC bytes are doubled and,
// until binary mode is negotiated, bare CR/LF become the NVT CR LF pair.
func (c *Codec) Encode(data []byte) []byte {
	output := make([]byte, 0, len(data)+4)
	binary := c.localEnabled[optBinary]
	for i, b := range data {
		if !binary && b == 13 {
			output = pushEscaped(13, output)
			if i+1 >= len(data) || data[i+1] != 10 {
				output = pushEscaped(10, output)
			}
			continue
		}
		if !binary && b == 10 && (i == 0 || data[i-1] != 13) {
			output = pushEscaped(13, output)
		}
		output = pushEscaped(b, output)
	}
	return output
}

func (c *Codec) Resize(cols, rows int) {
	c.cols = cols
	c.rows = rows
	if c.localEnabled[optNAWS] {
		c.sendWindowSize()
	}
}

// Flush releases a CR held back for CR-NUL/CR-LF translation; called when the
// connection closes so a trailing CR is not lost.
func (c *Codec) Flush() {
	if !c.pendingCr {
		return
	}
	c.pendingCr = false
	c.receive([]byte{13})
}

func (c *Codec) negotiate(command, option byte) {
	if command == will {
		supported := option == optBinary || option == optEcho || option == optSuppressGoAhead
		if supported {
			if !c.remoteEnabled[option] {
				c.remoteEnabled[option] = true
				c.sendCommand(do, option)
			}
		} else {
			c.sendCommand(dont, option)
		}
		return
	}

	if command == wont {
		if c.remoteEnabled[option] {
			delete(c.remoteEnabled, option)
			c.sendCommand(dont, option)
		}
		return
	}

	if command == do {
		supported := option == optBinary ||
			option == optSuppressGoAhead ||
			option == optTerminalType ||
			option == optNAWS
		if supported {
			if !c.localEnabled[option] {
				c.localEnabled[option] = true
				c.sendCommand(will, option)
			}
			if option == optNAWS {
				c.sendWindowSize()
			}
		} else {
			c.sendCommand(wont, option)
		}
		return
	}

	if c.localEnabled[option] {
		delete(c.localEnabled, option)
		c.sendCommand(wont, option)
	}
}

func (c *Codec) subnegotiate(option byte, data []byte) {
	if option != optTerminalType ||
		!c.localEnabled[optTerminalType] ||
		len(data) == 0 ||
		data[0] != terminalTypeSend {
		return
	}
	c.sendSubnegotiation(optTerminalType, append([]byte{terminalTypeIs}, defaultTerminalType...))
}

func (c *Codec) sendWindowSize() {
	cols := min(65535, max(1, c.cols))
	rows := min(65535, max(1, c.rows))
	c.sendSubnegotiation(optNAWS, []byte{byte(cols >> 8), byte(cols), byte(rows >> 8), byte(rows)})
}

func (c *Codec) sendCommand(command, option byte) {
	c.send([]byte{iac, command, option})
}

func (c *Codec) sendSubnegotiation(option byte, data []byte) {
	frame := make([]byte, 0, len(data)+5)
	frame = append(frame, iac, sb, option)
	for _, b := range data {
		frame = pushEscaped(b, frame)
	}
	frame = append(frame, iac, se)
	c.send(frame)
}

func pushEscaped(b byte, output []byte) []byte {
	output = append(output, b)
	if b == iac {
		output = append(output, iac)
	}
	return output
}

// pushApplicationByte applies NVT decoding: outside binary mode a CR is held
// back one byte so CR-NUL collapses to CR while CR-LF passes through intact.
func (c *Codec) pushApplicationByte(b byte, output []byte) []byte {
	if c.remoteEnabled[optBinary] {
		if c.pendingCr {
			output = append(output, 13)
			c.pendingCr = false
		}
		return append(output, b)
	}
	if c.pendingCr {
		output = append(output, 13)
		c.pendingCr = false
		if b == 0 {
			return output
		}
	}
	if b == 13 {
		c.pendingCr = true
	} else {
		output = append(output, b)
	}
	return output
}
