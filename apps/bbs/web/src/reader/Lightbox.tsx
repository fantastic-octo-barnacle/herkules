import { Dialog, DialogContent, DialogTitle } from "@herkules/ui/components/dialog";

/**
 * Viewport-sized dialog for an inline article image. `src` drives it open;
 * Esc, the close button and anything that is not the picture itself close it —
 * the figure fills the viewport, so that is the backdrop click as far as the
 * reader cares.
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
  return (
    <Dialog
      open={src !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="h-dvh w-screen max-w-none rounded-none border-0 bg-paper p-0 text-ink shadow-none sm:max-w-none"
        aria-label={alt || "图片"}
        onClick={(event) => {
          if ((event.target as Element).tagName !== "IMG") onClose();
        }}
      >
        <DialogTitle className="sr-only">{alt || "图片"}</DialogTitle>
        {src && (
          <figure className="m-0 flex size-full cursor-zoom-out flex-col items-center justify-center gap-3.5 p-6">
            <img
              className="max-h-[calc(100dvh-100px)] max-w-full cursor-default object-contain"
              src={src}
              alt={alt}
              referrerPolicy="no-referrer"
            />
            {alt && (
              <figcaption className="max-w-[72ch] text-center font-mono text-[12.5px] leading-normal text-muted-foreground">
                {alt}
              </figcaption>
            )}
          </figure>
        )}
      </DialogContent>
    </Dialog>
  );
}
