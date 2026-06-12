import { useEffect, useRef } from "react";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  destructive?: boolean;
}

/**
 * Native <dialog> confirm component. Uses showModal() for proper focus
 * trapping and backdrop. Baseline since 2022 — no polyfill needed.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  onConfirm,
  onCancel,
  destructive = false,
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Handle Escape key (native dialog behavior) and backdrop click.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const handleCancel = (e: Event) => {
      e.preventDefault();
      onCancel();
    };
    const handleClick = (e: MouseEvent) => {
      if (e.target === dialog) onCancel(); // backdrop click
    };
    dialog.addEventListener("cancel", handleCancel);
    dialog.addEventListener("click", handleClick);
    return () => {
      dialog.removeEventListener("cancel", handleCancel);
      dialog.removeEventListener("click", handleClick);
    };
  }, [onCancel]);

  const btnColor = destructive
    ? "border-crit/60 bg-crit/10 text-crit hover:bg-crit/20"
    : "border-accent/60 bg-accent/10 text-accent hover:bg-accent/20";

  return (
    <dialog ref={ref} id="confirm-dialog">
      <div className="p-5">
        <h3 className="font-display text-lg font-bold tracking-wide text-ink">
          {title}
        </h3>
        <p className="mt-2 text-sm text-ink-dim leading-relaxed">{message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-sm border border-line px-3 py-2 text-sm font-medium text-ink-dim hover:bg-raised hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`rounded-sm border px-3 py-2 text-sm font-semibold ${btnColor}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
