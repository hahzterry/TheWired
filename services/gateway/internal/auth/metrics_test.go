package auth

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/thewired/gateway/internal/metrics"
)

func authFailures(reason string) float64 {
	return metrics.Default.Value("gateway_auth_failures_total", reason)
}

// tamper decodes a signed header, lets edit change the event, and re-encodes
// it WITHOUT re-signing.
func tamper(t *testing.T, header string, edit func(*NostrEvent)) string {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(header, "Nostr "))
	if err != nil {
		t.Fatal(err)
	}
	var ev NostrEvent
	if err := json.Unmarshal(raw, &ev); err != nil {
		t.Fatal(err)
	}
	edit(&ev)
	j, _ := json.Marshal(ev)
	return "Nostr " + base64.StdEncoding.EncodeToString(j)
}

// Every way an Authorization header can be refused is counted under its own
// reason, and the reason is one of a fixed set — never the offending value.
func TestAuthFailuresCountedByReason(t *testing.T) {
	const url = "http://gateway/api/spaces"
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	h := NIP98MiddlewareWithOptions(Options{Replay: &fakeReplayGuard{seen: map[string]bool{}}, PayloadMode: PayloadEnforce}, next)

	cases := []struct {
		reason string
		method string
		header func() string
		body   string
	}{
		{metrics.AuthInvalidScheme, "GET", func() string { return "Bearer abc" }, ""},
		{metrics.AuthInvalidBase64, "GET", func() string { return "Nostr !!!not-base64" }, ""},
		{metrics.AuthInvalidEventJSON, "GET", func() string {
			return "Nostr " + base64.StdEncoding.EncodeToString([]byte("not json"))
		}, ""},
		{metrics.AuthWrongKind, "GET", func() string {
			return tamper(t, signedAuthHeader(t, "GET", url), func(e *NostrEvent) { e.Kind = 1 })
		}, ""},
		{metrics.AuthStaleTimestamp, "GET", func() string {
			return tamper(t, signedAuthHeader(t, "GET", url), func(e *NostrEvent) { e.CreatedAt = time.Now().Unix() - 3600 })
		}, ""},
		{metrics.AuthURLMismatch, "GET", func() string { return signedAuthHeader(t, "GET", "http://gateway/api/other") }, ""},
		{metrics.AuthMethodMismatch, "GET", func() string { return signedAuthHeader(t, "POST", url) }, ""},
		{metrics.AuthInvalidID, "GET", func() string {
			return tamper(t, signedAuthHeader(t, "GET", url), func(e *NostrEvent) { e.Content = "changed after signing" })
		}, ""},
		{metrics.AuthInvalidSignature, "GET", func() string {
			return tamper(t, signedAuthHeader(t, "GET", url), func(e *NostrEvent) {
				// A well-formed signature that is not this event's.
				e.Sig = strings.Repeat("ab", 64)
			})
		}, ""},
		{metrics.AuthPayloadMismatch, "POST", func() string {
			return signedAuthHeaderWithTags(t, "POST", url, [][]string{{"payload", strings.Repeat("0", 64)}})
		}, `{"a":1}`},
		{metrics.AuthPayloadRequired, "POST", func() string { return signedAuthHeader(t, "POST", url) }, `{"a":1}`},
	}

	for _, tc := range cases {
		t.Run(tc.reason, func(t *testing.T) {
			before := authFailures(tc.reason)
			var body *strings.Reader
			if tc.body != "" {
				body = strings.NewReader(tc.body)
			}
			var req *http.Request
			if body != nil {
				req = httptest.NewRequest(tc.method, url, body)
			} else {
				req = httptest.NewRequest(tc.method, url, nil)
			}
			req.Header.Set("Authorization", tc.header())
			rr := httptest.NewRecorder()
			h.ServeHTTP(rr, req)
			if rr.Code != http.StatusUnauthorized {
				t.Fatalf("expected 401, got %d (%s)", rr.Code, rr.Body.String())
			}
			if got := authFailures(tc.reason) - before; got != 1 {
				t.Fatalf("gateway_auth_failures_total{reason=%q} moved by %v, want 1", tc.reason, got)
			}
		})
	}
}

func TestAuthReplayCounted(t *testing.T) {
	const url = "http://gateway/api/spaces"
	h := NIP98MiddlewareWithOptions(Options{Replay: &fakeReplayGuard{seen: map[string]bool{}}},
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	header := signedAuthHeader(t, "GET", url)
	before := authFailures(metrics.AuthReplay)

	for i, want := range []int{http.StatusOK, http.StatusUnauthorized} {
		req := httptest.NewRequest("GET", url, nil)
		req.Header.Set("Authorization", header)
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != want {
			t.Fatalf("use %d: got %d, want %d", i+1, rr.Code, want)
		}
	}
	if got := authFailures(metrics.AuthReplay) - before; got != 1 {
		t.Fatalf("replay counted %v times, want 1", got)
	}
}

// A valid header and an absent one are not failures.
func TestAuthSuccessAndAnonymousAreNotCounted(t *testing.T) {
	const url = "http://gateway/api/spaces"
	h := NIP98Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))

	var b strings.Builder
	metrics.Default.Write(&b)
	before := b.String()

	req := httptest.NewRequest("GET", url, nil)
	req.Header.Set("Authorization", signedAuthHeader(t, "GET", url))
	h.ServeHTTP(httptest.NewRecorder(), req)
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", url, nil))

	b.Reset()
	metrics.Default.Write(&b)
	if failuresOnly(before) != failuresOnly(b.String()) {
		t.Fatalf("a successful or anonymous request moved the auth-failure counters")
	}
}

func failuresOnly(dump string) string {
	var lines []string
	for _, l := range strings.Split(dump, "\n") {
		if strings.HasPrefix(l, "gateway_auth_failures_total") {
			lines = append(lines, l)
		}
	}
	return strings.Join(lines, "\n")
}

// No client-controlled value (pubkey, URL, event id) may appear in a label.
func TestAuthFailureLabelsCarryNoClientData(t *testing.T) {
	const url = "http://gateway/api/spaces?secret=hunter2"
	h := NIP98Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	header := signedAuthHeader(t, "GET", "http://gateway/api/elsewhere")
	req := httptest.NewRequest("GET", url, nil)
	req.Header.Set("Authorization", header)
	h.ServeHTTP(httptest.NewRecorder(), req)

	raw, _ := base64.StdEncoding.DecodeString(strings.TrimPrefix(header, "Nostr "))
	var ev NostrEvent
	json.Unmarshal(raw, &ev)

	var b strings.Builder
	metrics.Default.Write(&b)
	for _, secret := range []string{ev.PubKey, ev.ID, "hunter2", "elsewhere"} {
		if strings.Contains(b.String(), secret) {
			t.Errorf("metrics output contains client data %q", secret)
		}
	}
}
