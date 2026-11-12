# 单词卡 · Word Cards

个人学习用单词卡：输入单词 → 翻转卡片 → 正反两个方向各累计标记 5 次 → 自动归档。

**卡片即笔记**：每张卡在服务器上是一篇 Markdown 笔记，由 noesis 建索引；前端保持原样。

## 结构

```
单词卡/                          # 前端 + 服务
├── index.html
├── manifest.webmanifest
├── server.mjs                   # 静态文件 + /api/state + 笔记读写 + noesis 索引
├── assets/…                     # css / js / icon
├── data/meta.json               # 版本号 + 删除墓碑（运行时生成）
├── deploy/wordcard.service
├── evidence/                    # 验收截图（不部署）
└── README.md

服务器知识库（默认 /home/ubuntu/kb）
├── notes/<单词>.md              # 一张卡 = 一篇笔记（唯一数据源）
├── docs/                        # 从本机资产库导入的文档
├── _trash/                      # 删除的笔记移到这里
├── kb.config.json
└── .noesis/                     # noesis 索引（可重建）
```

笔记示例：

```markdown
---
title: "manambatra"
tags: ["word","v."]
date: "2026-11-04"
card_id: "d231fd29-…"
pos: "v."
meaning: "团结"
note: ""
markWord: 4
markMeaning: 1
isArchived: false
updatedAt: 1793805655273
---

释义：团结
词性：v.
进度：英 4/5 · 汉 1/5
```

## 同步与刷新

- 启动：先渲染本地缓存（秒开），再 `GET /api/state` 对齐，`POST` 回传本地改动。
- 改动：700ms 防抖推送；服务端写入笔记并把变更增量重建 noesis 索引（1.5s 防抖）。
- 刷新：页面可见时每 8 秒 `GET /api/state?since=<version>`，版本没变只回 `{unchanged:true}`，不传词库；变了就整轮同步。
- 切回标签页、窗口聚焦、网络恢复时立即检查一次。
- 删除：写墓碑 `{id: 删除时间}`，对应笔记移到 `_trash/`；墓碑 30 天后清理。
- 冲突：同 id 取 `updatedAt` 较新者；墓碑时间 ≥ 卡片更新时间即视为删除。

## 检索

```bash
node /home/ubuntu/noesis/bin/noesis.mjs search /home/ubuntu/kb "团结"
node /home/ubuntu/noesis/bin/noesis.mjs stats  /home/ubuntu/kb
```

卡片和导入的文档在同一个索引里，中英混合检索。

## 部署

```bash
rsync -az --delete \
  --exclude '.git' --exclude '.DS_Store' --exclude 'evidence' --exclude 'data' \
  ./ ubuntu@82.156.224.5:/home/ubuntu/wordcard/
ssh ubuntu@82.156.224.5 'sudo systemctl restart wordcard'
```

首次启动若发现旧的 `data/state.json` 且知识库为空，会自动把卡片迁移成笔记（只跑一次）。

## 可选口令

`Environment=SYNC_PIN=你的口令`；每台设备首次同步提示一次。站点是 HTTP，口令与内容在链路上不加密，仅适合个人使用。

## 备份

备份 `/home/ubuntu/kb`（笔记 + 可重建的索引）与 `data/meta.json`（版本与墓碑）。
