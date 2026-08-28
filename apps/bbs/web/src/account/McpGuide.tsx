/**
 * The MCP snippet. Its own module (router-free, testable) and the single place the
 * endpoint URL is written — /about links here rather than repeating the command.
 */
import "./account.css";

export const MCP_URL = `${__PUBLIC_ORIGIN__}/mcp/bbs`;
export const MCP_ADD = `claude mcp add --transport http rm-wenku ${MCP_URL}`;

export function McpGuide() {
  return (
    <section className="card account-panel account-guide">
      <h2>接入 AI 助手（MCP）</h2>
      <p>
        本站提供只读的 MCP 服务器：<code>{MCP_URL}</code>
        。助手可以搜索文章、读取正文、查看 AI 概览与知识库条目。Claude Code 里执行：
      </p>
      <pre>
        <code>{MCP_ADD}</code>
      </pre>
      <p className="meta">首次连接时助手会打开浏览器完成登录；不需要手动配置令牌。</p>
    </section>
  );
}
