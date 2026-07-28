package sshx

// OpenSSH user certificate handling: parse the public line written by
// ssh-keygen (the CertificateFile), pair it with its IdentityFile private
// key, and produce a signer that authenticates with the certificate.
//
// Port of server/src/ssh/certificates.ts. The ssh2-specific plumbing there
// (DER signature re-encoding, ParsedKey mutation) has no Go counterpart:
// x/crypto/ssh emits SSH wire-format signatures natively and provides
// ssh.NewCertSigner for the certificate authentication shape.

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"

	"golang.org/x/crypto/ssh"
)

var (
	certTypeRe   = regexp.MustCompile(`^(ssh-(?:rsa|dss|ed25519)|ecdsa-sha2-nistp(?:256|384|521))-cert-v0[01]@openssh\.com$`)
	certLineRe   = regexp.MustCompile(`^(\S+)\s+([A-Za-z0-9+/]+={0,2})(?:\s|$)`)
	certSuffixRe = regexp.MustCompile(`-cert-v0[01]@openssh\.com$`)
)

// OpenSshCertificate mirrors the OpenSshCertificate shape of the TypeScript
// module, plus the parsed x/crypto certificate for signer construction.
type OpenSshCertificate struct {
	Source      []byte
	Type        string
	BaseType    string
	PublicBlob  []byte
	KeyFields   [][]byte
	Certificate *ssh.Certificate
}

// ParseSshPrivateKey parses an SSH private key, mirroring parseSshKey: with a
// passphrase the encrypted form is decrypted, otherwise the key must be plain.
func ParseSshPrivateKey(source []byte, passphrase []byte) (ssh.Signer, error) {
	if len(passphrase) > 0 {
		return ssh.ParsePrivateKeyWithPassphrase(source, passphrase)
	}
	return ssh.ParsePrivateKey(source)
}

// certReadField reads one uint32-length-prefixed SSH field.
func certReadField(data []byte, offset int) (value []byte, next int, ok bool) {
	if offset < 0 || offset+4 > len(data) {
		return nil, 0, false
	}
	length := int(binary.BigEndian.Uint32(data[offset:]))
	start := offset + 4
	end := start + length
	if length < 0 || end > len(data) {
		return nil, 0, false
	}
	return data[start:end], end, true
}

func certFieldCount(keyType string) int {
	switch {
	case keyType == "ssh-rsa":
		return 2
	case keyType == "ssh-dss":
		return 4
	case keyType == "ssh-ed25519":
		return 1
	case strings.HasPrefix(keyType, "ecdsa-sha2-"):
		return 2
	}
	return -1
}

func certReadKeyFields(blob []byte, expectedType string, certificate bool) ([][]byte, bool) {
	typ, offset, ok := certReadField(blob, 0)
	if !ok || string(typ) != expectedType {
		return nil, false
	}
	if certificate {
		_, next, ok := certReadField(blob, offset) // nonce
		if !ok {
			return nil, false
		}
		offset = next
	}
	baseType := expectedType
	if certificate {
		baseType = certSuffixRe.ReplaceAllString(expectedType, "")
	}
	count := certFieldCount(baseType)
	if count < 0 {
		return nil, false
	}
	fields := make([][]byte, 0, count)
	for i := 0; i < count; i++ {
		field, next, ok := certReadField(blob, offset)
		if !ok {
			return nil, false
		}
		fields = append(fields, field)
		offset = next
	}
	return fields, true
}

// ParseOpenSshCertificate parses the public line written by ssh-keygen for an
// OpenSSH user certificate.
func ParseOpenSshCertificate(source []byte) (*OpenSshCertificate, error) {
	line := strings.TrimSpace(string(source))
	match := certLineRe.FindStringSubmatch(line)
	if match == nil {
		return nil, errors.New("unsupported certificate format")
	}
	certType := match[1]
	typeMatch := certTypeRe.FindStringSubmatch(certType)
	if typeMatch == nil {
		name := certType
		if name == "" {
			name = "unknown"
		}
		return nil, fmt.Errorf("unsupported certificate type: %s", name)
	}
	publicBlob, err := base64.StdEncoding.DecodeString(match[2])
	if err != nil {
		return nil, errors.New("malformed OpenSSH certificate")
	}
	keyFields, ok := certReadKeyFields(publicBlob, certType, true)
	if !ok {
		return nil, errors.New("malformed OpenSSH certificate")
	}

	parsed, err := ssh.ParsePublicKey(publicBlob)
	if err != nil {
		return nil, err
	}
	cert, ok := parsed.(*ssh.Certificate)
	if !ok {
		return nil, errors.New("malformed OpenSSH certificate")
	}

	return &OpenSshCertificate{
		Source:      bytes.Clone(source),
		Type:        certType,
		BaseType:    typeMatch[1],
		PublicBlob:  publicBlob,
		KeyFields:   keyFields,
		Certificate: cert,
	}, nil
}

// CertificateMatchesKey reports whether the certificate contains the public
// half of this key.
func CertificateMatchesKey(certificate *OpenSshCertificate, publicKey ssh.PublicKey) bool {
	fields, ok := certReadKeyFields(publicKey.Marshal(), certificate.BaseType, false)
	if !ok || len(fields) != len(certificate.KeyFields) {
		return false
	}
	for i, field := range fields {
		if !bytes.Equal(field, certificate.KeyFields[i]) {
			return false
		}
	}
	return true
}

// CertificateAlgorithms lists the authentication algorithm variants to try
// for this certificate.
func CertificateAlgorithms(certificate *OpenSshCertificate) []string {
	if certificate.BaseType != "ssh-rsa" {
		return []string{certificate.Type}
	}
	suffix := certificate.Type[len("ssh-rsa"):]
	// Prefer SHA-2, as current OpenSSH disables ssh-rsa/SHA-1 by default,
	// while retaining the SHA-1 variant for older servers.
	return []string{
		"rsa-sha2-512" + suffix,
		"rsa-sha2-256" + suffix,
		certificate.Type,
	}
}

// CertifiedKey combines a public OpenSSH certificate with its private
// IdentityFile key into a signer whose public key is the certificate, giving
// the exact certificate authentication shape.
func CertifiedKey(privateKey ssh.Signer, certificate *OpenSshCertificate, algorithm string) (ssh.Signer, error) {
	if !CertificateMatchesKey(certificate, privateKey.PublicKey()) {
		return nil, errors.New("certificate does not match private key")
	}
	if !slices.Contains(CertificateAlgorithms(certificate), algorithm) {
		return nil, fmt.Errorf("unsupported certificate algorithm: %s", algorithm)
	}

	// For the rsa-sha2-* certificate variants, pin the underlying signature
	// algorithm the way the TypeScript wrapper picks the digest.
	signKey := privateKey
	if base := certSuffixRe.ReplaceAllString(algorithm, ""); base != privateKey.PublicKey().Type() {
		if algoSigner, ok := privateKey.(ssh.AlgorithmSigner); ok {
			if pinned, err := ssh.NewSignerWithAlgorithms(algoSigner, []string{base}); err == nil {
				signKey = pinned
			}
		}
	}
	return ssh.NewCertSigner(certificate.Certificate, signKey)
}
