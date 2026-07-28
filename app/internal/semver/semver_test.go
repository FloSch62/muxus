package semver

import "testing"

// Cases ported from tests/unit/shared/update-version.test.ts.
func TestIsNewerVersion(t *testing.T) {
	cases := []struct {
		name      string
		candidate string
		current   string
		want      bool
	}{
		{"stable core newer", "0.2.0", "0.1.1", true},
		{"v prefix and multi-digit", "V10.0.0", "v9.999.999", true},
		{"equal", "0.1.1", "0.1.1", false},
		{"older", "0.1.0", "0.1.1", false},
		{"final release beats prerelease", "0.2.0", "0.2.0-beta.1", true},
		{"prerelease loses to final", "0.2.0-beta.1", "0.2.0", false},
		{"numeric prerelease precedence", "1.0.0-beta.11", "1.0.0-beta.2", true},
		{"alpha beats shorter numeric chain", "1.0.0-rc.1", "1.0.0-beta.11", true},
		{"build metadata ignored", "1.0.0+build.2", "1.0.0+build.1", false},
		{"malformed core", "1.0", "0.9.0", false},
		{"leading-zero prerelease rejected", "1.0.0-beta.01", "1.0.0-beta.1", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsNewerVersion(tc.candidate, tc.current); got != tc.want {
				t.Fatalf("IsNewerVersion(%q, %q) = %v, want %v", tc.candidate, tc.current, got, tc.want)
			}
		})
	}
}
