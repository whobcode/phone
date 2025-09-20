# Conversion Notes: phone → Cloudflare

Status
- This subproject is a Go application (CLI/service). It directly targets system binaries and local environment — not a natural fit for Cloudflare Workers (no file system, no raw sockets, no long‑running processes).

Recommendation
- Do not convert core logic to a Worker. If needed, expose a lightweight HTTP facade in a Worker that forwards to a hosted API implemented in Go elsewhere.
- Optionally, add a static docs UI served via a Worker or Cloudflare Pages.

Next steps (if desired)
- Define minimal HTTP endpoints and deploy the Go API on a server. Use a Worker as an API gateway.
