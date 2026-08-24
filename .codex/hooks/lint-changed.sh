#!/bin/bash
# 与 .claude 的行为保持一致：仅对 JS/TS 文件执行 Biome 自动修复
exec .claude/hooks/lint-changed.sh
