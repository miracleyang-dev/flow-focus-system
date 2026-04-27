# 🌊 心流 (Flow) - 个人效率系统

<p align="center">
  <b>沉浸式专注，高效管理你的每一分钟。</b>
</p>

这是一个极简且高效的个人专注力与效率管理应用。基于现代 Web 技术与 Node.js 构建，拥有 PWA (Progressive Web App) 支持，助你在喧嚣的工作和学习中快速进入“心流”状态。

## ✨ 核心特性

- 🎯 **沉浸专注**：极简界面设计，减少干扰，助您快速进入深度工作状态。
- 📱 **PWA 支持**：支持安装到桌面或移动设备的主屏幕，离线可用，原生级体验。
- ⚡ **轻量后端**：使用 Node.js 驱动，配合 Redis (ioredis) 实现高速数据读写与状态管理。

## 🛠️ 技术栈

- **前端**: HTML5, CSS3, 原生 JavaScript
- **后端**: Node.js (基于 `http` 模块的原生服务)
- **存储**: Redis (主要数据源，支持 Railway 等云服务连接)，初期数据/备份可见 `data.json`
- **其他**: PWA (`manifest.json` & Service Worker `sw.js`)

## 📁 项目结构

```text
flow-focus-system/
├── index.html        # 主应用界面
├── app.js            # 前端交互与核心逻辑
├── style.css         # UI 样式文件
├── server.js         # Node.js 后端服务 API
├── data.json         # 数据存储/配置文件
├── package.json      # 项目依赖与配置
├── sw.js             # Service Worker (PWA 离线支持)
├── manifest.json     # PWA 应用配置
├── icons/            # 图标资源目录
└── LICENSE           # 开源协议文件
```

## 🚀 快速开始

### 运行环境要求

- [Node.js](https://nodejs.org/) (建议 v14 及以上版本)
- [Redis](https://redis.io/) (确保本地或远程 Redis 服务已启动)

### 安装依赖

克隆项目后，进入项目目录并安装必需的后端依赖：

```bash
npm install
```

### 启动应用

在命令行中执行以下命令：

```bash
npm start
# 或者是直接运行: node server.js
```

*(注：本地运行需确保 Redis 已启动并放行默认 6379 端口，应用启动后请在浏览器访问 `http://localhost:3000`)*

### ☁️ 云端部署 (如 Railway)

本项目已对云端服务进行适配优化（例如基于环境变量）。配置好 `REDIS_URL` 和 `PORT` 环境变量后，可直接一键部署到 [Railway](https://railway.app/) 或其他 Node.js 托管平台。

## 📱 PWA 安装指南

1. 使用 Chrome 或 Edge 等现代浏览器打开本应用。
2. 观察浏览器地址栏右侧，点击 **“安装此应用”** 图标。
3. （可选）勾选创建桌面快捷方式。此后你可以像打开普通软件一样直接打开“心流”。

## 📄 开源协议

本项目采用 [MIT License](LICENSE) 协议进行开源，欢迎自由使用、修改和分发。
