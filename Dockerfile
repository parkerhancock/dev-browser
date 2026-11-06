# dev-browser as a service: standalone Chromium + HTTP API + MCP on one port.
#
#   docker build -t dev-browser .
#   docker run -d -p 9222:9222 -v dev-browser-data:/data dev-browser
#
# The token is generated on first start at /data/token (print it with
# `docker exec <ctr> cat /data/token`), or pin it by setting DEV_BROWSER_TOKEN.
# Agents connect with:
#   library: connect("http://host:9222", { token })
#   MCP:     http://host:9222/mcp with header X-DevBrowser-Token: <token>
#
# The base image tag must match the locked playwright version
# (skills/dev-browser/package-lock.json) so the bundled Chromium is present.
FROM mcr.microsoft.com/playwright:v1.57.0-noble

WORKDIR /app

# Install each package's dependencies (tsx is a runtime dependency: the CLI
# launcher registers it to run the TypeScript sources directly).
COPY skills/dev-browser/package.json skills/dev-browser/package-lock.json skills/dev-browser/
RUN cd skills/dev-browser && npm ci
COPY mcp-server/package.json mcp-server/package-lock.json mcp-server/
RUN cd mcp-server && npm ci

COPY skills/dev-browser/ skills/dev-browser/
COPY mcp-server/ mcp-server/

# Persistent state: auth token and the browser profile both live in /data
ENV DEV_BROWSER_DIR=/data
VOLUME /data
EXPOSE 9222

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD sh -c 'curl -fsS -H "X-DevBrowser-Token: $(cat /data/token)" http://127.0.0.1:9222/health || exit 1'

# 0.0.0.0 is container-internal; publish the port as narrowly as you need.
# Chromium's own CDP debug port stays on loopback inside the container —
# the only way in is the authenticated /cdp proxy on 9222.
CMD ["node", "mcp-server/bin/dev-browser.mjs", "serve", \
     "--host", "0.0.0.0", "--mcp", "--profile-dir", "/data"]
