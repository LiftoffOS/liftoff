package config

import "os"

type Config struct {
	GCPProjectID                string
	ChiselBindAddr              string
	TunnelBaseDomain            string
	PlatformBackendURL          string
	PlatformBackendServiceToken string
	UsageEndpoint               string
}

func FromEnv() Config {
	return Config{
		GCPProjectID:                os.Getenv("GCP_PROJECT_ID"),
		// Chisel always binds loopback-only. The HTTP dispatcher (port 8080,
		// the only externally-exposed port) reverse-proxies /_tunnel/ws to
		// this loopback port so chisel sees the customer's WebSocket through
		// the dispatcher.
		ChiselBindAddr:              getenvDefault("CHISEL_BIND_ADDR", "127.0.0.1:7000"),
		TunnelBaseDomain:            getenvDefault("TUNNEL_BASE_DOMAIN", "tunnels.example.com"),
		PlatformBackendURL:          os.Getenv("PLATFORM_BACKEND_URL"),
		PlatformBackendServiceToken: os.Getenv("PLATFORM_BACKEND_SERVICE_TOKEN"),
		UsageEndpoint:               os.Getenv("USAGE_ENDPOINT"),
	}
}

func getenvDefault(key, def string) string {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	return v
}
