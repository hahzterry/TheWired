package metrics

import (
	"runtime"
	"syscall"
	"time"
)

var processStart = time.Now()

func init() {
	goroutines := Default.NewGauge("go_goroutines", "Goroutines that currently exist.")
	heapAlloc := Default.NewGauge("go_memstats_heap_alloc_bytes", "Heap bytes allocated and still in use.")
	sysBytes := Default.NewGauge("go_memstats_sys_bytes", "Bytes of memory obtained from the OS.")
	gcCount := Default.NewCounter("go_gc_cycles_total", "Completed GC cycles.")
	startTime := Default.NewGauge("process_start_time_seconds", "Unix time the process started.")
	cpuSeconds := Default.NewCounter("process_cpu_seconds_total", "User and system CPU time spent by the process.")
	dropped := Default.NewGauge(
		"gateway_metrics_dropped_series",
		"Observations dropped because a metric reached its series cap. Non-zero means a label is unbounded.",
	)

	Default.OnCollect(func() {
		var m runtime.MemStats
		runtime.ReadMemStats(&m)
		goroutines.Set(float64(runtime.NumGoroutine()))
		heapAlloc.Set(float64(m.HeapAlloc))
		sysBytes.Set(float64(m.Sys))
		gcCount.setTotal(float64(m.NumGC))
		startTime.Set(float64(processStart.Unix()))

		var ru syscall.Rusage
		if err := syscall.Getrusage(syscall.RUSAGE_SELF, &ru); err == nil {
			cpu := time.Duration(ru.Utime.Nano() + ru.Stime.Nano())
			cpuSeconds.setTotal(cpu.Seconds())
		}
		dropped.Set(float64(Default.Dropped()))
	})
}
