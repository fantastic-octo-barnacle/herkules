import { useEffect, useRef } from "react";

/**
 * Viewport-sized `<dialog>` for an inline article image. The element is always
 * mounted (a `<dialog>` that is never in the tree cannot animate its own close),
 * and `src` drives `showModal()` / `close()`; Esc and the backdrop both reach
 * `onClose` through the platform's own `close` event.
 */
export function Lightbox({
  src,
  alt,
  onClose,
}: {
  src: string | null;
  alt: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (src && !dialog.open) dialog.showModal();
    else if (!src && dialog.open) dialog.close();
  }, [src]);

  return (
    <dialog
      ref={ref}
      className="reader-lightbox"
      aria-label={alt || "图片"}
      onClose={onClose}
      // Anything that is not the picture itself closes it — the figure fills
      // the viewport, so this is the backdrop click as far as the reader cares.
      onClick={(event) => {
        if ((event.target as Element).tagName !== "IMG") event.currentTarget.close();
      }}
    >
      <button className="reader-lightbox-close" type="button" aria-label="关闭" onClick={onClose}>
        ×
      </button>
      {src && (
        <figure>
          <img src={src} alt={alt} referrerPolicy="no-referrer" />
          {alt && <figcaption>{alt}</figcaption>}
        </figure>
      )}
    </dialog>
  );
}
