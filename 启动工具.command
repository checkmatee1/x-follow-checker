#!/bin/zsh
set -e
cd -- "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if command -v node >/dev/null 2>&1; then
  exec node src/server.mjs
elif [[ -x "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" ]]; then
  exec "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" src/server.mjs
else
  print "需要 Node.js 20 或更新版本，请安装后再启动：https://nodejs.org/"
  read -r "reply?按回车关闭窗口…"
fi
