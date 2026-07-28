package telnetx

import (
	"bytes"
	"testing"
)

type codecFixture struct {
	sent     [][]byte
	received [][]byte
	codec    *Codec
}

func newCodecFixture(cols, rows int) *codecFixture {
	f := &codecFixture{}
	f.codec = NewCodec(cols, rows,
		func(data []byte) { f.sent = append(f.sent, append([]byte(nil), data...)) },
		func(data []byte) { f.received = append(f.received, append([]byte(nil), data...)) },
	)
	return f
}

func (f *codecFixture) receivedBytes() []byte {
	return bytes.Join(f.received, nil)
}

func assertFrames(t *testing.T, label string, got, want [][]byte) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s: got %d frames %v, want %d frames %v", label, len(got), got, len(want), want)
	}
	for i := range want {
		if !bytes.Equal(got[i], want[i]) {
			t.Fatalf("%s[%d] = %v, want %v", label, i, got[i], want[i])
		}
	}
}

func TestCodecParsesFragmentedNegotiationWithoutLeakingIAC(t *testing.T) {
	f := newCodecFixture(80, 24)
	f.codec.Feed(append([]byte("hello"), iac, will))
	f.codec.Feed(append([]byte{optEcho}, " world"...))

	if got := string(f.receivedBytes()); got != "hello world" {
		t.Fatalf("received %q, want %q", got, "hello world")
	}
	assertFrames(t, "sent", f.sent, [][]byte{{iac, do, optEcho}})
}

func TestCodecAnswersTerminalTypeSendAcrossChunkBoundaries(t *testing.T) {
	f := newCodecFixture(80, 24)
	f.codec.Feed([]byte{iac, do, optTerminalType})
	f.codec.Feed([]byte{iac, sb, optTerminalType})
	f.codec.Feed([]byte{terminalTypeSend, iac})
	f.codec.Feed([]byte{se})

	want := append([]byte{iac, sb, optTerminalType, terminalTypeIs}, defaultTerminalType...)
	want = append(want, iac, se)
	assertFrames(t, "sent", f.sent, [][]byte{{iac, will, optTerminalType}, want})
}

func TestCodecAdvertisesAndUpdatesWindowSize(t *testing.T) {
	f := newCodecFixture(132, 43)
	f.codec.Feed([]byte{iac, do, optNAWS})
	assertFrames(t, "sent", f.sent, [][]byte{
		{iac, will, optNAWS},
		{iac, sb, optNAWS, 0, 132, 0, 43, iac, se},
	})

	f.codec.Resize(200, 50)
	if len(f.sent) != 3 || !bytes.Equal(f.sent[2], []byte{iac, sb, optNAWS, 0, 200, 0, 50, iac, se}) {
		t.Fatalf("resize sent %v, want NAWS 200x50", f.sent[2:])
	}
}

func TestCodecRefusesUnsupportedOptions(t *testing.T) {
	f := newCodecFixture(80, 24)
	f.codec.Feed([]byte{iac, do, 39, iac, will, 34})
	assertFrames(t, "sent", f.sent, [][]byte{
		{iac, wont, 39},
		{iac, dont, 34},
	})
}

func TestCodecEscapesIACAndTranslatesNewlinesUntilBinary(t *testing.T) {
	f := newCodecFixture(80, 24)
	if got := f.codec.Encode([]byte{65, 13, 255}); !bytes.Equal(got, []byte{65, 13, 10, 255, 255}) {
		t.Fatalf("encode = %v, want [65 13 10 255 255]", got)
	}

	f.codec.Feed([]byte{iac, do, optBinary})
	if got := f.codec.Encode([]byte{13, 255}); !bytes.Equal(got, []byte{13, 255, 255}) {
		t.Fatalf("binary encode = %v, want [13 255 255]", got)
	}
}

func TestCodecDecodesCRNULWhilePreservingCRLF(t *testing.T) {
	f := newCodecFixture(80, 24)
	f.codec.Feed([]byte{65, 13})
	f.codec.Feed([]byte{0, 66, 13, 10, 67})
	if got := f.receivedBytes(); !bytes.Equal(got, []byte{65, 13, 66, 13, 10, 67}) {
		t.Fatalf("received %v, want [65 13 66 13 10 67]", got)
	}
}
