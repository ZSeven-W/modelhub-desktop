# ModelHub-Desktop

> 本地 LLM 模型管理器 — Local LLM Model Manager Desktop App

![macOS](https://img.shields.io/badge/macOS-Silicon-orange)
![Electron](https://img.shields.io/badge/Electron-28-blue)
![License](https://img.shields.io/badge/License-MIT-green)

## Overview

ModelHub-Desktop 是运行在 macOS 上的本地 LLM 模型管理器，基于 Ollama 生态。用户可以浏览、下载、管理和整理本地的 LLM 模型。

## Features

- 🔍 **模型发现** — 搜索/浏览 Ollama 模型库，按参数量、量化方式筛选
- ⬇️ **模型下载** — 实时进度跟踪（SSE），支持下载队列、取消和中断恢复
- 🛑 **下载取消** — 随时取消正在下载的模型
- 🔔 **系统通知** — 下载完成时发送 macOS 通知
- 📦 **模型管理** — 查看/删除已安装模型，显示详细信息
- 🏷️ **标签分类** — 创建彩色标签，整理模型（卡片上直接显示标签）
- ⭐ **收藏夹** — 标记常用模型
- 📊 **存储统计** — 可视化图表（饼图/柱状图），磁盘占用分析
- ⚖️ **模型对比** — 多模型并排比较参数和规格
- 🚀 **快速启动** — 一键在终端运行模型
- ⌨️ **键盘快捷键** — `Cmd+K` 搜索，`Cmd+R` 刷新，`Esc` 关闭
- 📋 **批量删除** — 多选模型后批量删除
- 🕐 **下载历史** — 查看历史下载记录（成功/失败/取消）
- 📝 **上下文长度** — 模型详情中显示上下文长度
- 🔄 **实时更新** — SSE 流式推送下载进度，无需轮询

## Prerequisites

- macOS (Apple Silicon 或 Intel)
- [Ollama](https://ollama.com) 已安装并运行
- Node.js 18+

## Quick Start

```bash
cd modelhub-desktop
npm install
npm start
```

## Architecture

```
┌─────────────────────┐
│   Electron Main     │  ← main.js (Node.js)
│   Process           │
│   - Window mgmt     │
│   - IPC handlers    │
│   - Tray icon       │
└─────────┬───────────┘
          │ IPC
┌─────────▼───────────┐
│  Python Backend    │  ← server.py (Express + SQLite)
│  (Port 3357)       │
│  - Ollama CLI ops  │
│  - Database        │
│  - File system     │
└─────────────────────┘
          │ REST API
          ▼
┌─────────────────────┐
│  Renderer Process  │  ← public/ (Vanilla JS/HTML/CSS)
│  - Model UI        │
│  - Search/Filter   │
│  - Progress bars   │
└─────────────────────┘
```

## Tech Stack

- **Frontend**: Electron 28 + Vanilla JS/HTML/CSS
- **Backend**: Python 3 + Express + SQLite + Ollama CLI
- **Styling**: Custom CSS (dark theme)
- **Icons**: Inline SVG

## License

MIT — ZSeven-W
