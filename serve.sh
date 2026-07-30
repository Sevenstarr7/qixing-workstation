#!/bin/bash
# 七星堆肥厂 PWA 本地守护脚本
# 用法: bash serve.sh  (会一直跑，进程挂了自动重启)
cd /Users/sevenstar/WorkBuddy/2026-07-28-15-17-28/qixing-workstation
while true; do
  /Users/sevenstar/.workbuddy/binaries/python/versions/3.13.12/bin/python3 -m http.server 3000
  sleep 2
done
