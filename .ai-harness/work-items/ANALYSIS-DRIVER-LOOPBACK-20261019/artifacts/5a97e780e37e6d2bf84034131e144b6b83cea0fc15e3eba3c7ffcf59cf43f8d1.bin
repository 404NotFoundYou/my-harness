FROM ai-harness/codex:0.156.0-node22.20.0
COPY preload.cjs server.cjs /opt/fixture/
ENV NODE_OPTIONS=--require=/opt/fixture/preload.cjs
WORKDIR /workspace
