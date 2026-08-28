/**
 * The MCP guide. Its own module (router-free, testable) and the single place the
 * endpoint URL is written — /about links here rather than repeating the command.
 *
 * One subsection per client because each client stores MCP configuration in a
 * different place. Supported clients run OAuth themselves. Copilot CLI cannot,
 * and saying so plainly is more useful than a config block that fails at the
 * first request.
 */
export const MCP_URL = `${__PUBLIC_ORIGIN__}/mcp/bbs`;
export const MCP_ADD = `claude mcp add --transport http rm-wenku ${MCP_URL}`;

/** The platform's dev-token page — the only bearer token this platform hands out by hand. */
const DEV_TOKEN_URL = `${__PUBLIC_ORIGIN__}/dev-token`;

const VSCODE_JSON = `{
  "servers": {
    "rm-wenku": { "type": "http", "url": "${MCP_URL}" }
  }
}`;

const CURSOR_JSON = `{
  "mcpServers": {
    "rm-wenku": { "url": "${MCP_URL}" }
  }
}`;

const ZED_JSON = `{
  "context_servers": {
    "rm-wenku": { "url": "${MCP_URL}" }
  }
}`;

const CODEX_ADD = `codex mcp add rm-wenku --url ${MCP_URL}
codex mcp login rm-wenku`;

const GEMINI_ADD = `gemini mcp add --transport http --scope user rm-wenku ${MCP_URL}`;

const COPILOT_JSON = `{
  "mcpServers": {
    "rm-wenku": {
      "type": "http",
      "url": "${MCP_URL}",
      "tools": ["*"],
      "headers": { "Authorization": "Bearer <15 分钟令牌>" }
    }
  }
}`;

export function McpGuide() {
  return (
    <section className="mt-4 rounded-lg border border-line bg-surface px-[1.4rem] py-5 [&_h3]:mt-[1.6rem] [&_h3]:border-t [&_h3]:border-line-2 [&_h3]:pt-4 [&_pre]:mt-[0.6rem]">
      <h2>接入 AI 助手（MCP）</h2>
      <p>
        本站提供只读的 MCP 服务器：<code>{MCP_URL}</code>
        。助手可以搜索文章、读取正文、查看 AI 概览与知识库条目。按你使用的客户端选一种接入方式。
      </p>

      <h3>Claude Code</h3>
      <p>
        命令行添加，然后在会话里执行 <code>/mcp</code> 完成登录：
      </p>
      <pre>
        <code>{MCP_ADD}</code>
      </pre>

      <h3>Cursor</h3>
      <p>
        写入项目的 <code>.cursor/mcp.json</code>，或写入全局的 <code>~/.cursor/mcp.json</code>
        。保存后打开 Customize → MCPs，在 <code>rm-wenku</code> 上点击连接并完成登录。
      </p>
      <pre>
        <code>{CURSOR_JSON}</code>
      </pre>

      <h3>VS Code（1.106 及以上）</h3>
      <p>
        写入工作区的 <code>.vscode/mcp.json</code>，或用命令面板的 “MCP: Open User Configuration”
        写进用户配置；也可以用 “MCP: Add Server” 选 HTTP
        逐步填写。保存后在该服务器条目上点击登录，授权会自动完成。
      </p>
      <pre>
        <code>{VSCODE_JSON}</code>
      </pre>

      <h3>Codex</h3>
      <p>命令行两条，第二条会打开浏览器登录：</p>
      <pre>
        <code>{CODEX_ADD}</code>
      </pre>
      <p>
        等价的 <code>~/.codex/config.toml</code> 写法是 <code>[mcp_servers.rm-wenku]</code> 加一行{" "}
        <code>url = "{MCP_URL}"</code>。Codex 的 IDE 扩展则在齿轮菜单里选 MCP servers → Add server →
        Streamable HTTP，填入地址后保存，重启扩展，再点击授权。
      </p>

      <h3>Zed</h3>
      <p>
        在 Agent 设置页点击 Add Server → Add Remote Server 并填入地址，或把下面的配置写入 Zed 的{" "}
        <code>settings.json</code>。不要添加 Authorization 请求头，Zed 会自动打开本站的登录页。
      </p>
      <pre>
        <code>{ZED_JSON}</code>
      </pre>

      <h3>Gemini CLI</h3>
      <p>
        下面的命令把服务器写入用户配置。启动 Gemini CLI 后执行 <code>/mcp auth rm-wenku</code>
        ，浏览器会打开登录页。
      </p>
      <pre>
        <code>{GEMINI_ADD}</code>
      </pre>

      <h3>GitHub Copilot CLI</h3>
      <p>
        暂不支持。Copilot CLI 对远程服务器没有登录流程，只能发送固定的请求头，而本站不签发长期令牌。
        只想试一次的话，可以在 <a href={DEV_TOKEN_URL}>{DEV_TOKEN_URL}</a> 取一个受众为{" "}
        <code>mcp/bbs</code> 的令牌，写进 <code>~/.copilot/mcp-config.json</code>；它 15
        分钟后过期，不适合日常使用。
      </p>
      <pre>
        <code>{COPILOT_JSON}</code>
      </pre>

      <p className="meta">
        首次连接时客户端会打开浏览器完成登录；除 Copilot CLI 外都不需要手动配置令牌。
      </p>
    </section>
  );
}
