import { Link } from "@tanstack/react-router";
import { useState } from "react";

import type { ArticleDTO } from "../../../src/api/dto.ts";
import { linkKindText } from "../lib/format.ts";

type ArticleLink = ArticleDTO["links"][number];

/** The first five links; the rest are one click away. */
const PREVIEW = 5;

/** Host + path reads better than a bare URL when the crawler found no label. */
function label(link: ArticleLink): string {
  if (link.label && link.label !== link.url) return link.label;
  try {
    const url = new URL(link.url);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return link.url;
  }
}

/**
 * Outbound links and the article's images. A link whose target is in this
 * library is a router link (`articleId`), everything else leaves the site.
 * Images are listed by caption and open in a new tab rather than the reader's
 * lightbox: the lightbox belongs to the body, and a sidebar thumbnail grid at
 * ≤ 960 px would push the sheet's real content off screen.
 */
export function Resources({
  links,
  images,
}: {
  links: ArticleDTO["links"];
  images: ArticleDTO["images"];
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? links : links.slice(0, PREVIEW);
  const hidden = links.length - shown.length;

  if (links.length === 0 && images.length === 0) return null;

  return (
    <>
      {shown.length > 0 && (
        <div className="reader-res-list">
          {shown.map((link) => (
            <div className="reader-res" key={link.url}>
              <span className="k">{link.articleId ? "本站" : linkKindText(link.kind)}</span>
              {link.articleId ? (
                <Link to="/articles/$id" params={{ id: link.articleId }} title={link.url}>
                  {label(link)}
                </Link>
              ) : (
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  title={link.url}
                >
                  {label(link)}
                </a>
              )}
            </div>
          ))}
        </div>
      )}
      {hidden > 0 && (
        <button className="reader-res-more" type="button" onClick={() => setExpanded(true)}>
          还有 {hidden} 个链接
        </button>
      )}
      {images.length > 0 && (
        <div className="reader-res-images">
          <span className="label">原文图片 {images.length}</span>
          <ol>
            {images.map((image, index) => (
              <li key={image.url}>
                <a href={image.url} target="_blank" rel="noopener noreferrer">
                  {image.alt ?? `图片 ${index + 1}`}
                </a>
              </li>
            ))}
          </ol>
        </div>
      )}
    </>
  );
}
