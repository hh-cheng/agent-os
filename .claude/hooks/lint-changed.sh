#!/bin/bash
# 取出本次被改动的文件路径
file=$(jq -r '.tool_input.file_path')

# 只对 JS/TS 文件跑 Biome
if [[ "$file" == *.ts || "$file" == *.tsx || "$file" == *.js || "$file" == *.jsx ]]; then
  bun biome check --write "$file" >&2 || exit 2
fi
