#!/bin/zsh
# 每日 00:00 把服务器上的代码与词库笔记同步到 GitHub 仓库
# 由 launchd: com.hanryer.wordcards.daily-sync 调用
set -u

export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export HTTPS_PROXY=http://127.0.0.1:7897
export HTTP_PROXY=http://127.0.0.1:7897
export LANG=zh_CN.UTF-8

REPO="$HOME/Harena资产库/04-项目-projects/单词卡"
SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=15"
PUSH_LOG="/tmp/wordcards-sync-push.log"

log() { echo "[$(date '+%F %T')] $*"; }

cd "$REPO" || { log "找不到仓库目录"; exit 1; }

# 1) 服务器可达性
if ! ssh $=SSH_OPTS tencent 'true' 2>/dev/null; then
  log "服务器不可达，跳过本次同步"
  exit 1
fi

# 2) 代码镜像（不删除本地独有文件）
if ! rsync -az --exclude '.git' --exclude 'data' --exclude 'evidence' --exclude '.DS_Store' \
  -e "ssh $SSH_OPTS" tencent:/home/ubuntu/wordcard/ ./; then
  log "代码同步失败"
  exit 1
fi

# 3) 词库笔记镜像
mkdir -p kb/notes kb/docs
if ! rsync -az --delete -e "ssh $SSH_OPTS" tencent:/home/ubuntu/kb/notes/ kb/notes/; then
  log "词库笔记同步失败"
  exit 1
fi
rsync -az --delete -e "ssh $SSH_OPTS" tencent:/home/ubuntu/kb/docs/ kb/docs/ || true
ssh $=SSH_OPTS tencent 'cat /home/ubuntu/wordcard/data/meta.json 2>/dev/null' > kb/meta.json || rm -f kb/meta.json

# 4) 提交并推送
git add -A
if git diff --cached --quiet; then
  log "无变化，跳过提交"
  exit 0
fi

STAMP="$(date +%F)"
git commit -m "chore: 每日同步 ${STAMP}" >/dev/null || { log "提交失败"; exit 1; }

if git push origin main >>"$PUSH_LOG" 2>&1; then
  log "已推送 $(git rev-parse --short HEAD)"
else
  log "推送失败，见 $PUSH_LOG"
  exit 1
fi
