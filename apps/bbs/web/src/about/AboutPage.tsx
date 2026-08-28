/**
 * `/about` — rewritten for this archive. rm-wenku's copy described a live crawler
 * with a 10-minute poll; here the corpus is imported, search is trigram, and the
 * one integration worth documenting is MCP.
 */
import { Link } from "@tanstack/react-router";

import { MCP_URL } from "../account/McpGuide.tsx";
import { usePageTitle } from "../shell/usePageTitle.ts";

export function AboutPage() {
  usePageTitle("关于");
  return (
    <div className="page">
      <h1 className="page-title">关于 RM 文库</h1>
      <p className="lede">
        这是一个非官方、独立实现的 RoboMaster
        开发者社区文章归档，目标是让队伍更快找到并读懂别人已经公开的方案。
      </p>

      <h2>这里有什么</h2>
      <p>
        社区公开文章的正文、标签、图片与资源链接的一份副本，按发布时间排列；每篇文章附带一份 AI
        概览与结构化的知识库字段（参数、取舍、踩坑），可以按条目跨文章比较。 导入批次与规模在
        <Link to="/status">状态</Link>页。
      </p>

      <h2>搜索怎么工作</h2>
      <p>
        搜索把你输入的内容切成若干片段，每个片段都要在文章里出现（是「与」不是「或」），再按匹配的密集程度排序，命中处在结果里高亮。
        因为匹配的是子串而不是词，所以不需要分词，<code>底盘功率</code> 和 <code>PID</code>{" "}
        一样能查；代价是极短的片段会命中得过宽。
        标题、全文、知识库三个范围只改变检索的字段，排序规则相同。想按时间而不是相关度看，回到文章列表用同样的筛选即可。
      </p>

      <h2>接入 AI 助手（MCP）</h2>
      <p>
        本站同时是一个只读的 MCP 服务器：<code>{MCP_URL}</code>
        。助手可以搜索文章、读取正文、查看 AI 概览与知识库条目。 接入方式在
        <Link to="/account">账户</Link>页。
      </p>

      <h2>内容声明</h2>
      <p>
        正文与图片的版权归原作者与 RoboMaster
        所有，本站只做检索与阅读，每篇文章都保留原文链接。规则、通知与技术细节请以官方原文为准； AI
        概览由模型生成，可能出错，不能替代原文。
      </p>
    </div>
  );
}
