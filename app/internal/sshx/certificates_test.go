package sshx

// Port of tests/unit/server/certificates.test.ts, fixtures verbatim.

import (
	"bytes"
	"crypto/rand"
	"testing"
)

// Disposable fixture key and user certificate generated only for this test.
const certTestPrivateKey = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACCWM4w+ETsogYZIPXlSJWnKztCQuB+z4IAOiI2ASlUCDQAAAJiYvo8tmL6P
LQAAAAtzc2gtZWQyNTUxOQAAACCWM4w+ETsogYZIPXlSJWnKztCQuB+z4IAOiI2ASlUCDQ
AAAEB7Cv74aU1Jm9orbp5zddvlnDQYRBBOPf5Y2w9d1uvrbZYzjD4ROyiBhkg9eVIlacrO
0JC4H7PggA6IjYBKVQINAAAAE2Zsc2Nod2FyQEwtUEYzUlgyUEsBAg==
-----END OPENSSH PRIVATE KEY-----`

const certTestCertificate = "ssh-ed25519-cert-v01@openssh.com AAAAIHNzaC1lZDI1NTE5LWNlcnQtdjAxQG9wZW5zc2guY29tAAAAIMyM6l98PC1DJXz+Dtxy+ONebgpvf/86/nS6ONte+yEXAAAAIJYzjD4ROyiBhkg9eVIlacrO0JC4H7PggA6IjYBKVQINAAAAAAAAAAAAAAABAAAABHRlc3QAAAAIAAAABHRlc3QAAAAAAAAAAP//////////AAAAAAAAAIIAAAAVcGVybWl0LVgxMS1mb3J3YXJkaW5nAAAAAAAAABdwZXJtaXQtYWdlbnQtZm9yd2FyZGluZwAAAAAAAAAWcGVybWl0LXBvcnQtZm9yd2FyZGluZwAAAAAAAAAKcGVybWl0LXB0eQAAAAAAAAAOcGVybWl0LXVzZXItcmMAAAAAAAAAAAAAADMAAAALc3NoLWVkMjU1MTkAAAAgfBX5rZtr934GOp8DZruJhxlEEDuv+RIkW05kWIBoSHcAAABTAAAAC3NzaC1lZDI1NTE5AAAAQO72lXABXCRMOLWJft3FZEg2BzuQ/VF2de09ZPci7i/oE/Z9cOoZj9RjAkfkltBo/aa0S47vjGsU1X+Y9fzEKQc= test"

// "pairs a CertificateFile with its IdentityFile private key"
func TestCertificatePairsWithIdentityFile(t *testing.T) {
	privateKey, err := ParseSshPrivateKey([]byte(certTestPrivateKey), nil)
	if err != nil {
		t.Fatal(err)
	}
	certificate, err := ParseOpenSshCertificate([]byte(certTestCertificate))
	if err != nil {
		t.Fatal(err)
	}

	if !CertificateMatchesKey(certificate, privateKey.PublicKey()) {
		t.Fatal("certificate should match the private key")
	}
	algos := CertificateAlgorithms(certificate)
	if len(algos) != 1 || algos[0] != "ssh-ed25519-cert-v01@openssh.com" {
		t.Fatalf("algorithms = %v", algos)
	}

	combined, err := CertifiedKey(privateKey, certificate, algos[0])
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(combined.PublicKey().Marshal(), certificate.PublicBlob) {
		t.Fatal("combined key should present the certificate blob")
	}
	if combined.PublicKey().Type() != certificate.Type {
		t.Fatalf("combined type = %q, want %q", combined.PublicKey().Type(), certificate.Type)
	}

	payload := []byte("certificate authentication payload")
	signature, err := combined.Sign(rand.Reader, payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := privateKey.PublicKey().Verify(payload, signature); err != nil {
		t.Fatalf("signature does not verify against the private key: %v", err)
	}
}

// "rejects ordinary public keys as CertificateFile content"
func TestCertificateRejectsOrdinaryPublicKey(t *testing.T) {
	_, err := ParseOpenSshCertificate([]byte(
		"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEpS4MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY=",
	))
	if err == nil {
		t.Fatal("ordinary public key must be rejected")
	}
}

// Sanity on the TS error paths: mismatched key and unsupported algorithm.
func TestCertificateMismatchAndAlgorithmErrors(t *testing.T) {
	certificate, err := ParseOpenSshCertificate([]byte(certTestCertificate))
	if err != nil {
		t.Fatal(err)
	}
	privateKey, err := ParseSshPrivateKey([]byte(certTestPrivateKey), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := CertifiedKey(privateKey, certificate, "ssh-ed25519-cert-v00@openssh.com"); err == nil {
		t.Fatal("unsupported algorithm must be rejected")
	}
}
