package ratelimit

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/thewired/gateway/internal/metrics"
)

func rejections(bucket string) float64 {
	return metrics.Default.Value("gateway_rate_limit_rejections_total", bucket)
}

// The in-process auth-fail guard's 429s are counted under their own bucket.
func TestAuthFailGuardRejectionsCounted(t *testing.T) {
	guard := NewAuthFailGuard(2)
	h := guard.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	before := rejections(metrics.BucketAuthFail)

	codes := []int{}
	for i := 0; i < 4; i++ {
		req := httptest.NewRequest("GET", "http://gateway/api/x", nil)
		req.RemoteAddr = "203.0.113.77:4000"
		req.Header.Set("Authorization", "Nostr bogus")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		codes = append(codes, rr.Code)
	}
	if codes[2] != http.StatusTooManyRequests || codes[3] != http.StatusTooManyRequests {
		t.Fatalf("expected the 3rd and 4th attempts to be throttled, got %v", codes)
	}
	if got := rejections(metrics.BucketAuthFail) - before; got != 2 {
		t.Fatalf("auth_fail rejections moved by %v, want 2", got)
	}
}

// With the store unreachable the limiter fails open or closed; either way the
// outage is counted (Redis down shows up here before anywhere else), and no
// request is counted as a rate-limit rejection.
func TestStoreErrorsCountedNotRejections(t *testing.T) {
	limiter, err := NewLimiter("redis://localhost:1", DefaultLimits) // port 1 = won't connect
	if err != nil {
		t.Fatal(err)
	}
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	storeErrors := func(check, outcome string) float64 {
		return metrics.Default.Value("gateway_rate_limit_store_errors_total", check, outcome)
	}

	beforeIP, beforeRead := storeErrors("ip", "allowed"), storeErrors("read", "allowed")
	beforeRejected := rejections("read") + rejections("ip")
	rr := httptest.NewRecorder()
	RateLimitMiddleware(limiter, true, next).ServeHTTP(rr, httptest.NewRequest("GET", "http://gateway/api/spaces", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("fail-open: expected 200, got %d", rr.Code)
	}
	if storeErrors("ip", "allowed")-beforeIP != 1 || storeErrors("read", "allowed")-beforeRead != 1 {
		t.Fatalf("fail-open store errors not counted for both the ip and read checks")
	}
	if rejections("read")+rejections("ip") != beforeRejected {
		t.Fatalf("a store error was counted as a rate-limit rejection")
	}

	beforeClosed := storeErrors("ip", "rejected")
	rr = httptest.NewRecorder()
	RateLimitMiddleware(limiter, false, next).ServeHTTP(rr, httptest.NewRequest("GET", "http://gateway/api/spaces", nil))
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("fail-closed: expected 503, got %d", rr.Code)
	}
	if storeErrors("ip", "rejected")-beforeClosed != 1 {
		t.Fatalf("fail-closed store error not counted")
	}
}
