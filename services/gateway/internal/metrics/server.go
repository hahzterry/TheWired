package metrics

import (
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// ParseAddr reads METRICS_ADDR: "host:port", "[v6]:port", ":port" or a bare
// port. A missing host means loopback, so the listener is reachable from other
// containers only when a host is given on purpose. "" returns "" (listener
// off); anything malformed is an error so a typo fails the boot instead of
// silently exporting nothing.
func ParseAddr(raw string) (string, error) {
	v := strings.TrimSpace(raw)
	if v == "" {
		return "", nil
	}
	bad := fmt.Errorf("METRICS_ADDR %q: expected host:port, [v6]:port, :port or a port", v)

	host, port := "", v
	if strings.Contains(v, ":") {
		h, p, err := net.SplitHostPort(v)
		if err != nil {
			return "", bad
		}
		host, port = h, p
	}
	if host == "" {
		host = "127.0.0.1"
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return "", bad
	}
	return net.JoinHostPort(host, strconv.Itoa(n)), nil
}

// Handler serves the registry at exactly /metrics and nothing else.
func Handler(reg *Registry) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/metrics" {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", ContentType)
		w.Header().Set("Cache-Control", "no-store")
		if r.Method == http.MethodHead {
			return
		}
		reg.Write(w)
	})
}

// NewServer builds the internal metrics listener. It is a separate
// http.Server from the public one on purpose: the public port is what the web
// proxy forwards to, so nothing served there is private.
func NewServer(addr string, reg *Registry) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           Handler(reg),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
}
