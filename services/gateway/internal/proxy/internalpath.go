package proxy

import (
	"net/http"
	"path"
	"strings"

	"github.com/thewired/gateway/internal/metrics"
)

// internalBackendPaths are backend paths that exist for operators, not
// clients. The backend serves its metrics from a separate listener that the
// gateway never dials, so today nothing answers here — this refusal is the
// second lock: if a metrics route is ever mounted on the backend's API port,
// `/api/metrics` still does not reach it.
var internalBackendPaths = []string{"/metrics"}

// IsInternalBackendPath reports whether a backend path (the request path with
// the /api prefix already stripped, percent-decoded) names an internal-only
// endpoint or anything under one. The comparison is on the cleaned,
// lower-cased path so `/metrics/`, `//metrics`, `/./metrics`, `/x/../metrics`
// and `/METRICS` are all caught, however the backend's router would have
// normalized them.
func IsInternalBackendPath(backendPath string) bool {
	// A backslash is a separator to some routers and a literal to others;
	// treat it as one so `\metrics` cannot slip through either way.
	p := strings.ReplaceAll(backendPath, `\`, "/")
	p = strings.ToLower(path.Clean("/" + p))
	for _, internal := range internalBackendPaths {
		if p == internal || strings.HasPrefix(p, internal+"/") {
			return true
		}
	}
	return false
}

// InternalPathGuard answers 404 for an /api request whose backend path is
// internal-only, before authentication, rate limiting or the proxy run: the
// refusal costs no signature verify and no store round trip, and cannot be
// turned into a different answer by a later layer.
func InternalPathGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if backendPath, _ := stripAPIPrefix(r.URL); IsInternalBackendPath(backendPath) {
			metrics.InternalPathBlocked()
			http.NotFound(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}
