import type { ArticleAiDTO } from "../../../src/api/dto.ts";
import { maturityClass, sectionLabels } from "../lib/ai.ts";

type Overview = NonNullable<ArticleAiDTO["overview"]>;

/**
 * The AI overview card. `status` is the whole state machine — there is no
 * polling and no refresh button: the generator runs on another box, so a
 * `pending` row is a fact to report, not something this page can wait for.
 */
export function AiOverview({ ai }: { ai: ArticleAiDTO }) {
  switch (ai.status) {
    case "pending":
      return (
        <div className="reader-ai">
          <p className="reader-ai-note">这篇文章的 AI 概览尚未生成。</p>
        </div>
      );
    case "failed":
      return (
        <div className="reader-ai">
          <p className="reader-ai-error">概览生成失败{ai.error ? `：${ai.error}` : ""}。</p>
        </div>
      );
    case "ready":
      return ai.overview ? (
        <OverviewBody overview={ai.overview} model={ai.model} />
      ) : (
        // `ready` without a body is a generator bug, not a state worth a design.
        <div className="reader-ai">
          <p className="reader-ai-note">这篇文章的 AI 概览尚未生成。</p>
        </div>
      );
    default: {
      const never: never = ai.status;
      return never;
    }
  }
}

function OverviewBody({ overview, model }: { overview: Overview; model: string | null }) {
  const labels = sectionLabels(overview.genre);
  const { extras } = overview;
  const maturity = maturityClass(overview.maturity.status);
  return (
    <div className="reader-ai">
      <div className="reader-ai-pills">
        {overview.genre && <span className="pill genre">{overview.genre}</span>}
        {maturity && (
          <span className={maturity} title={overview.maturity.evidence ?? undefined}>
            {overview.maturity.status}
          </span>
        )}
      </div>
      {overview.tldr && <p className="reader-ai-tldr">{overview.tldr}</p>}
      {extras.thesis && (
        <p className="reader-ai-thesis">
          <span className="label">主张</span>
          {extras.thesis}
        </p>
      )}
      {overview.summary && <p>{overview.summary}</p>}
      {overview.keyPoints.length > 0 && (
        <>
          <span className="label">{labels.keyPoints}</span>
          <ul>
            {overview.keyPoints.map((point, index) => (
              <li key={index}>{point}</li>
            ))}
          </ul>
        </>
      )}
      {extras.arguments.length > 0 && (
        <>
          <span className="label">论点</span>
          <ul>
            {extras.arguments.map((a, index) => (
              <li key={index}>
                {a.claim}
                {a.evidence && <span className="fine"> — {a.evidence}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      {overview.appliesWhen && (
        <>
          <span className="label">{labels.appliesWhen}</span>
          <p>{overview.appliesWhen}</p>
        </>
      )}
      {extras.compat.length > 0 && (
        <>
          <span className="label">环境</span>
          <ul>
            {extras.compat.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </>
      )}
      {extras.quickStart.length > 0 && (
        <>
          <span className="label">上手</span>
          <ol>
            {extras.quickStart.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ol>
        </>
      )}
      {extras.portingChecklist.length > 0 && (
        <>
          <span className="label">换到自己车上要改</span>
          <ul className="reader-ai-checklist">
            {extras.portingChecklist.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </>
      )}
      {extras.lessons.length > 0 && (
        <>
          <span className="label">经验</span>
          <ul className="reader-ai-lessons">
            {extras.lessons.map((lesson, index) => (
              <li key={index}>
                <div>
                  <span className="constraint">{lesson.constraint}</span>
                  <span className="arrow" aria-hidden="true">
                    {" → "}
                  </span>
                  {lesson.decision}
                </div>
                {lesson.outcome && <div className="outcome">{lesson.outcome}</div>}
                {lesson.transferable && <div className="transferable">{lesson.transferable}</div>}
              </li>
            ))}
          </ul>
        </>
      )}
      {extras.actions.length > 0 && (
        <>
          <span className="label">可以直接做的</span>
          <ul className="reader-ai-checklist">
            {extras.actions.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </>
      )}
      {overview.package.length > 0 && labels.package && (
        <>
          <span className="label">{labels.package}</span>
          <ul>
            {overview.package.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </>
      )}
      {overview.caveats.length > 0 && (
        <>
          <span className="label">{labels.caveats}</span>
          <ul>
            {overview.caveats.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </>
      )}
      {overview.readingGuide && (
        <>
          <span className="label">阅读建议</span>
          <p>{overview.readingGuide}</p>
        </>
      )}
      {overview.faq.length > 0 && (
        <details className="reader-ai-faq">
          <summary>
            常见问题<span className="count">{overview.faq.length}</span>
          </summary>
          <dl>
            {overview.faq.map((item, index) => (
              <div key={index}>
                <dt>{item.question}</dt>
                <dd>
                  {item.answer}
                  {item.source && <span className="src">{item.source}</span>}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      {overview.maturity.evidence && (
        <p className="reader-ai-evidence">
          <span className="label">依据</span>「{overview.maturity.evidence}」
        </p>
      )}
      <p className="fine">
        由 {model ?? "AI"} 根据正文、附件、仓库文档与参考文献生成，可能有误，请以原文为准。
      </p>
    </div>
  );
}
