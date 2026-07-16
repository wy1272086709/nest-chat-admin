# 示例目录

本目录存放与 Nest Admin Chat Backend 对接的参考代码。示例用于说明协议和关键流程，不参与后端构建，也不是可以直接部署的完整客户端应用。

## 示例清单

| 目录 | 内容 | 适用场景 |
| --- | --- | --- |
| [`reliable-messaging/`](./reliable-messaging/) | 可靠消息客户端参考实现 | Web、Electron 或其他使用 Socket.IO 的 TypeScript 客户端 |

## 使用原则

- 先阅读对应目录中的 README，确认依赖、URL 和运行环境要求。
- 示例代码应复制或按模块方式引入客户端项目，并适配客户端自己的状态管理和安全存储。
- 不要在示例中写入真实 Token、API Key、数据库凭据或生产服务地址。
- 后端事件和 HTTP 契约以 `src/` 的实现及 `docs/` 中的接口文档为准。
- 修改公开事件、ack 或同步响应时，应同步更新示例和相关文档。

更完整的客户端接入流程见 [`docs/frontend-reliable-message-integration.md`](../docs/frontend-reliable-message-integration.md)。
