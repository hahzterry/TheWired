package proxy

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestIsInternalBackendPath(t *testing.T) {
	internal := []string{
		"/metrics",
		"/metrics/",
		"/metrics/anything",
		"//metrics",
		"/./metrics",
		"/spaces/../metrics",
		"/METRICS",
		"/Metrics/",
		`\metrics`,
		"metrics",
	}
	for _, p := range internal {
		if !IsInternalBackendPath(p) {
			t.Errorf("%q must be refused", p)
		}
	}

	public := []string{
		"/",
		"/health",
		"/spaces",
		"/spaces/metrics",         // a space that happens to be named metrics
		"/music/insights/metrics", // only the root is internal
		"/metricsx",               // not a path-segment match
		"/analytics/space/abc",
	}
	for _, p := range public {
		if IsInternalBackendPath(p) {
			t.Errorf("%q is an ordinary API path and must pass", p)
		}
	}
}

// The router refuses on its own, without the server's front guard: mounting
// router.Handler() somewhere new cannot open the path.
func TestRouterRefusesInternalPathItself(t *testing.T) {
	hit := false
	be := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hit = true }))
	defer be.Close()
	h := NewRouter(be.URL, nil).Handler()

	for _, target := range []string{"/api/metrics", "/api/metrics/x", "/api/METRICS"} {
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, httptest.NewRequest("GET", "http://gateway"+target, nil))
		if rr.Code != http.StatusNotFound || hit {
			t.Fatalf("%s: code %d, reached backend=%v", target, rr.Code, hit)
		}
	}

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "http://gateway/api/spaces", nil))
	if rr.Code != http.StatusOK || !hit {
		t.Fatalf("an ordinary path must still be forwarded: %d", rr.Code)
	}
}

func TestInternalPathGuardShortCircuits(t *testing.T) {
	ran := false
	h := InternalPathGuard(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { ran = true }))
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("POST", "http://gateway/api/metrics", nil))
	if rr.Code != http.StatusNotFound || ran {
		t.Fatalf("guard let /api/metrics through: %d ran=%v", rr.Code, ran)
	}
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "http://gateway/api/health", nil))
	if !ran {
		t.Fatal("guard blocked an ordinary path")
	}
}
