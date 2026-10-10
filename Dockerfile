# Only for MCP directories (such as Glama) that start the server to list its tools.
# To use the guard yourself, run `npx -y @tradeagentslab/guard init` on your own machine.
#
# The image holds no keys or config. Each time the container starts it writes the default
# paper-trading config and makes a fresh signing key, then serves MCP on stdio.
# Paper trading only: no exchange account, no API key.
FROM node:22.12.0-alpine
RUN npm install -g @tradeagentslab/guard@0.1.0 && npm cache clean --force
USER node
WORKDIR /home/node
CMD ["sh", "-c", "tal init --agent demo --only none >&2 && exec tal serve"]
