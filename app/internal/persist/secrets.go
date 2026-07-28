package persist

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
)

var (
	camelBoundary = regexp.MustCompile(`([a-z0-9])([A-Z])`)
	nonAlnumRuns  = regexp.MustCompile(`(?i)[^a-z0-9]+`)
)

var sensitiveWords = map[string]bool{
	"password":   true,
	"passphrase": true,
	"secret":     true,
	"token":      true,
	"privatekey": true,
}

// referenceWords whitelist keys that merely point at a secret (a file path
// or a credential-store reference) instead of containing one.
var referenceWords = map[string]bool{
	"path":      true,
	"file":      true,
	"filename":  true,
	"ref":       true,
	"reference": true,
	"id":        true,
}

// AssertSecretFree rejects secrets at the persistence boundary. Profiles may
// contain key paths and credential-reference IDs, but never passwords,
// passphrases, tokens, or private-key material. An empty location defaults
// to "config" like the TS original.
func AssertSecretFree(value any, location string) error {
	if location == "" {
		location = "config"
	}
	// Typed inputs are normalized through JSON first so their keys are the
	// exact camelCase names the TS implementation inspects.
	normalized, err := jsonNormalize(value)
	if err != nil {
		return err
	}
	return checkSecretFree(normalized, location)
}

func jsonNormalize(value any) (any, error) {
	if value == nil {
		return nil, nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func checkSecretFree(value any, location string) error {
	switch v := value.(type) {
	case []any:
		for index, item := range v {
			if err := checkSecretFree(item, fmt.Sprintf("%s[%d]", location, index)); err != nil {
				return err
			}
		}
	case map[string]any:
		// Sorted keys keep the reported key deterministic; TS iterates in
		// insertion order, which JSON decoding cannot preserve.
		keys := make([]string, 0, len(v))
		for key := range v {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			if isSensitiveKey(key) {
				return fmt.Errorf("%s.%s must be stored in the OS credential store, not the Muxus database", location, key)
			}
			if err := checkSecretFree(v[key], location+"."+key); err != nil {
				return err
			}
		}
	}
	return nil
}

func isSensitiveKey(key string) bool {
	words := splitKeyWords(key)
	sensitive := false
	for index, word := range words {
		if sensitiveWords[word] || (word == "private" && index+1 < len(words) && words[index+1] == "key") {
			sensitive = true
			break
		}
	}
	if !sensitive {
		return false
	}
	referenceOnly := len(words) > 0 && referenceWords[words[len(words)-1]]
	return !referenceOnly
}

func splitKeyWords(key string) []string {
	spaced := camelBoundary.ReplaceAllString(key, "$1 $2")
	parts := nonAlnumRuns.Split(spaced, -1)
	words := make([]string, 0, len(parts))
	for _, part := range parts {
		if part == "" {
			continue
		}
		words = append(words, lowerASCII(part))
	}
	return words
}

func lowerASCII(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + ('a' - 'A')
		}
	}
	return string(b)
}
