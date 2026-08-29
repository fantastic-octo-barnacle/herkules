/**
 * The one confirmation in the app. Every mutation the person doing it cannot
 * undo opens this: the question, the consequence spelled out, and a button
 * that says what it does rather than "OK".
 *
 * Trigger-based rather than controlled, so a table row renders its own dialog
 * and no page has to track which row is open.
 *
 * `field` is the single optional input (the disable reason). A form field
 * under `role="alertdialog"` is a small compromise, taken deliberately so this
 * app has one confirmation component instead of an AlertDialog and a Dialog
 * that look almost the same.
 */
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@herkules/ui/components/alert-dialog";
import { Input } from "@herkules/ui/components/input";
import { Label } from "@herkules/ui/components/label";
import type { ReactNode } from "react";
import { useId, useState } from "react";

export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel,
  destructive = true,
  field,
  onConfirm,
}: {
  /** The button that opens it; rendered as the trigger itself, so it keeps its own styling. */
  readonly trigger: ReactNode;
  readonly title: string;
  /** Inline content only — it renders inside a `<p>`. */
  readonly description: ReactNode;
  readonly confirmLabel: string;
  readonly destructive?: boolean;
  readonly field?: { readonly label: string; readonly placeholder?: string };
  /** `value` is the trimmed field, or undefined when it is empty or absent. */
  readonly onConfirm: (value?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const fieldId = useId();

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setValue(""); // never carry a previous row's reason into this one
      }}
    >
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {field ? (
          <div className="grid gap-1.5">
            <Label htmlFor={fieldId}>{field.label}</Label>
            <Input
              id={fieldId}
              value={value}
              placeholder={field.placeholder}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? "destructive" : "default"}
            onClick={() => onConfirm(field ? value.trim() || undefined : undefined)}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
