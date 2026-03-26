# CLAUDE.md — ModelHub-Desktop

## 项目规范

本项目遵循 ZSeven-W 开发团队规范。

### 分支策略
- 功能开发在 `feature/` 分支
- 不直接 commit 到 main
- Commit message 遵循 Conventional Commits

### 代码风格
- **JavaScript**: ES6+, 2空格缩进, 分号结尾
- **Python**: Black 格式化, 4空格缩进
- **CSS**: 2空格缩进, BEM-like 命名

### 提交格式
```
feat(modelhub-desktop): add model comparison feature
fix(server): handle ollama timeout gracefully
docs(readme): update installation instructions
```

### API 设计
- RESTful 风格
- JSON 响应格式统一: `{ success: bool, data: any, error?: string }`
- 端口: 3357

### 测试
- 手动测试为主 (Electron GUI app)
- Python backend 可用 curl 测试

### 安全
- 不在代码中硬编码敏感信息
- 用户数据存储在 app data 目录
