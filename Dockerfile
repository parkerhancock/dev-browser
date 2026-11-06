# dev-browser as a service: standalone browser + HTTP API + MCP on one port.
#
#   docker build -t dev-browser .
#   docker run -d -p 9222:9222 -v dev-browser-data:/data dev-browser
#
# BROWSER picks the browser baked into the image (default: branded Google
# Chrome, for real-site fingerprint and codecs). Chrome has no Linux ARM64
# build, so on Apple Silicon build either with --platform linux/amd64 or:
#
#   docker build --build-arg BROWSER=chromium -t dev-browser .
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

# chrome | chromium | msedge (chromium is Playwright's bundled build,
# already present in the base image; the branded browsers install via
# Playwright's channel mechanism below)
ARG BROWSER=chrome

WORKDIR /app

# Install each package's dependencies (tsx is a runtime dependency: the CLI
# launcher registers it to run the TypeScript sources directly).
COPY skills/dev-browser/package.json skills/dev-browser/package-lock.json skills/dev-browser/
RUN cd skills/dev-browser && npm ci
COPY mcp-server/package.json mcp-server/package-lock.json mcp-server/
RUN cd mcp-server && npm ci

# Branded browsers aren't in the Playwright base image
RUN if [ "$BROWSER" != "chromium" ]; then \
      cd skills/dev-browser && npx playwright install "$BROWSER"; \
    fi

COPY skills/dev-browser/ skills/dev-browser/
COPY mcp-server/ mcp-server/

# Persistent state: auth token and the browser profile both live in /data
ENV DEV_BROWSER_DIR=/data
ENV DEV_BROWSER_BROWSER=$BROWSER
VOLUME /data
EXPOSE 9222

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD sh -c 'curl -fsS -H "X-DevBrowser-Token: $(cat /data/token)" http://127.0.0.1:9222/health || exit 1'

# 0.0.0.0 is container-internal; publish the port as narrowly as you need.
# The browser's own CDP debug port stays on loopback inside the container —
# the only way in is the authenticated /cdp proxy on 9222.
# (sh expands $DEV_BROWSER_BROWSER, then exec makes node PID 1 so the
# server's signal handlers see docker stop.)
CMD ["sh", "-c", "exec node mcp-server/bin/dev-browser.mjs serve --host 0.0.0.0 --mcp --profile-dir /data --browser \"$DEV_BROWSER_BROWSER\""]
