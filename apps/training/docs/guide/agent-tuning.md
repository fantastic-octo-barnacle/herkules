# 用 Agent 协助调参

这是本地 MCP bridge，不需要上线新服务。Agent 通过标准输入输出连接 MCP，浏览器通过带一次性进程令牌的 WebSocket 连接同一台电脑上的 bridge。每个 bridge 只接受一个实验页面；关闭页面或断开连接就会停止 Agent 控制。

## 启动

在 Herkules 仓库根目录执行 `vp install`，再运行 `vp run @herkules/training#dev`。打开 `http://127.0.0.1:3004/labs/pid`。

在支持 stdio MCP 的客户端添加以下服务器；将路径替换为本机仓库的绝对路径。使用 Node 24，直接运行脚本，避免包管理器日志干扰 MCP 的标准输出。

```json
{
  "mcpServers": {
    "herkules-training": {
      "command": "node",
      "args": ["/absolute/path/to/herkules/apps/training/src/agent/main.ts"]
    }
  }
}
```

请 Agent 调用 `connect_lab`，把返回的 `url` 粘贴到实验页的「Agent 调参」面板，点击连接。配对地址只留在页面内存中，不存储到本地或发送给托管服务器。新 bridge 进程生成新的令牌。端口默认 3014，可用 `TRAINING_BRIDGE_PORT` 修改。

线上页面也允许连接该本地 bridge，但浏览器可能限制 HTTPS 页面访问本地 WebSocket；遇到限制时使用上面的本地页面。无需关闭浏览器安全保护。

## 可用工具

| 工具             | 功能                                                                  |
| ---------------- | --------------------------------------------------------------------- |
| `connect_lab`    | 获取配对地址                                                          |
| `read_lab`       | 读取当前参数、范围、角度、力矩、运行状态与最近 12 秒历史              |
| `set_parameters` | 部分更新 Kp/Ki/Kd、力矩限幅、目标角度或抗积分饱和；保留当前运动与历史 |
| `set_running`    | 暂停或继续                                                            |
| `reset_lab`      | 清空状态与历史，保留参数；仅在明确要重做实验时使用                    |

写入工具等待浏览器 Worker 确认。超时或断线不能证明写入未发生，应先重新读取状态再决定是否重试。手动控制与 Agent 更新都保留当前状态，最后应用的参数生效。

## 调参 Skill

仓库中的 `apps/training/skills/herkules-pid-tuning/SKILL.md` 可作为 Agent 的调参指南。支持 skills 的客户端可安装该文件夹，或直接让 Agent 阅读它。

示例请求：

> 连接我的 PID 实验，先记录当前状态。保留姿态与历史，调整增益让俯仰目标变化后振荡更小，并比较调参前后的角度误差与力矩。不要重置实验。

仿真角度为度，内部 PID 使用弧度，力矩单位为 N·m。两轴共用增益；俯仰含持续重力，偏航无重力力矩。模型不包含轴间惯性耦合或机械限位，调参结论只适用于此教学仿真。
