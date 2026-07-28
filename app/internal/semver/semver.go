// Package semver ports shared/src/update-version.ts: SemVer precedence used
// only by the update check. Build metadata is ignored; malformed input never
// reports "newer".
package semver

import (
	"regexp"
	"strings"
)

var semverRe = regexp.MustCompile(
	`^[vV]?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`,
)

var numericRe = regexp.MustCompile(`^\d+$`)

type parsed struct {
	core       [3]string
	prerelease []string
}

func parse(version string) *parsed {
	match := semverRe.FindStringSubmatch(strings.TrimSpace(version))
	if match == nil {
		return nil
	}
	var prerelease []string
	if match[4] != "" {
		prerelease = strings.Split(match[4], ".")
		for _, id := range prerelease {
			if numericRe.MatchString(id) && len(id) > 1 && strings.HasPrefix(id, "0") {
				return nil
			}
		}
	}
	return &parsed{core: [3]string{match[1], match[2], match[3]}, prerelease: prerelease}
}

// compareNumeric compares digit strings without leading zeros: longer wins,
// then lexicographic.
func compareNumeric(candidate, current string) int {
	if len(candidate) != len(current) {
		if len(candidate) > len(current) {
			return 1
		}
		return -1
	}
	return strings.Compare(candidate, current)
}

func comparePrerelease(candidate, current []string) int {
	if len(candidate) == 0 || len(current) == 0 {
		if len(candidate) == len(current) {
			return 0
		}
		if len(candidate) == 0 {
			return 1
		}
		return -1
	}
	length := max(len(candidate), len(current))
	for i := 0; i < length; i++ {
		if i >= len(candidate) {
			return -1
		}
		if i >= len(current) {
			return 1
		}
		next, installed := candidate[i], current[i]
		if next == installed {
			continue
		}
		nextNumeric := numericRe.MatchString(next)
		installedNumeric := numericRe.MatchString(installed)
		if nextNumeric && installedNumeric {
			return compareNumeric(next, installed)
		}
		if nextNumeric != installedNumeric {
			if nextNumeric {
				return -1
			}
			return 1
		}
		return strings.Compare(next, installed)
	}
	return 0
}

// IsNewerVersion reports whether candidate has higher SemVer precedence.
func IsNewerVersion(candidate, current string) bool {
	next := parse(candidate)
	installed := parse(current)
	if next == nil || installed == nil {
		return false
	}
	for i := range next.core {
		if precedence := compareNumeric(next.core[i], installed.core[i]); precedence != 0 {
			return precedence > 0
		}
	}
	return comparePrerelease(next.prerelease, installed.prerelease) > 0
}
