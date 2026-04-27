# Personal Blog

一个零依赖静态个人博客。文章内容放在 `content/` 下，用 Markdown 编写；运行构建脚本后会生成到 `public/`。

## 内容结构

```text
content/
  site.json
  profile.md
  assets/
    avatar.svg
  项目/
    论文复现/
      第一篇论文复现示例.md
    其他项目/
      项目示例.md
  博客分享/
    论文分享/
      论文阅读示例.md
    linux系统/
      Linux 常用命令.md
    其他/
      随笔示例.md
```

## 写文章

在对应文件夹新增 `.md` 文件即可。推荐在文件开头添加 front matter：

```md
---
title: 文章标题
date: 2026-04-25
tags: [tag1, tag2]
summary: 首页和分类页展示的摘要。
---

# 文章标题

正文内容。
```

## 新增栏目

栏目由 `content/` 下的文件夹自动生成，不需要改代码。

- 新增一级栏目：创建 `content/其他/`
- 新增二级板块：创建 `content/博客分享/生成模型/`
- 新增文章：把 `.md` 放到对应文件夹里，例如 `content/博客分享/生成模型/扩散模型入门.md`

即使新建的文件夹里暂时没有文章，首页也会显示对应栏目或板块，并标记为暂无文章。`content/site.json` 里的 `categoryOrder` 只是可选排序配置；不在列表里的新文件夹会自动追加显示。

## 修改个人信息

- 个人名字、简介、头像路径、个人网页、知乎、GitHub 链接：修改 `content/site.json`
- 更完整的个人介绍：修改 `content/profile.md`
- 头像：替换 `content/assets/avatar.svg`，也可以改成 `avatar.jpg` 或 `avatar.png`，并同步修改 `content/site.json` 里的 `avatar`

## 构建与预览

```bash
npm run cache-images
npm run build
npm run dev
```

如果 Markdown 里引用了远程图片，先运行 `npm run cache-images`，脚本会把图片保存到 `content/assets/remote/`。之后 `npm run build` 会优先使用本地缓存图片，避免外链图片加载失败。

构建后的首页在 `public/index.html`。如果只是本地查看，也可以直接用浏览器打开这个文件。
