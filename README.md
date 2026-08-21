# StepFun 知识库管理后台

基于 [StepFun Vector Store API](https://platform.stepfun.com/docs/zh/api-reference/vector-stores/create) 的知识库管理系统。

## 功能

- **知识库管理**：创建、查看、删除知识库（支持文本/图片两种类型）
- **文件管理**：上传文件到知识库、查看文件列表、从知识库中移除文件
- **统计概览**：查看知识库文件处理状态统计（总数/已完成/处理中/失败/已取消）
- **分页浏览**：支持知识库列表和文件列表的分页加载

## 技术栈

- 后端：Node.js + Express（API 代理层，保护 API Key）
- 前端：原生 HTML/CSS/JavaScript（无框架依赖）
- 文件上传：Multer（中间件） + StepFun Files API

## 快速开始

### 1. 配置 API Key

将 `.env.example` 复制为 `.env`，填入你的 StepFun API Key：

```bash
cp .env.example .env
```

```env
STEP_API_KEY=你的API密钥
PORT=3000
```

API Key 获取地址：https://platform.stepfun.com/interface-key

### 2. 安装依赖

```bash
npm install
```

### 3. 启动服务

```bash
npm start
```

访问 http://localhost:3000 即可使用。

## API 接口

### 后端代理接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/vector-stores` | 创建知识库 |
| GET | `/api/vector-stores` | 获取知识库列表 |
| GET | `/api/vector-stores/:id` | 获取知识库详情 |
| DELETE | `/api/vector-stores/:id` | 删除知识库 |
| POST | `/api/vector-stores/:id/files` | 添加文件到知识库 |
| GET | `/api/vector-stores/:id/files` | 获取知识库文件列表 |
| DELETE | `/api/vector-stores/:id/files/:fileId` | 从知识库移除文件 |
| POST | `/api/files` | 上传文件 |

### 对应的 StepFun API

所有后端接口均代理到 `https://api.stepfun.com/v1`，API Key 在服务端注入，前端无需暴露。

## 项目结构

```
stepfun_kb_cms/
├── server.js              # Express 服务器入口
├── package.json           # 项目配置
├── .env.example           # 环境变量模板
├── .env                   # 环境变量（需自行创建）
├── routes/
│   ├── vectorStores.js    # 知识库相关路由
│   └── files.js           # 文件上传路由
└── public/
    ├── index.html         # 前端主页面
    ├── css/
    │   └── style.css      # 样式文件
    └── js/
        └── app.js         # 前端逻辑
```
