"use client";

/**
 * Shared Stripe TEST checkout button — same look/behavior for credit packs and Radar plans.
 * Returns to the page that started checkout (pricing or credits).
 */
type Props = {
  label: string;
  pendingLabel?: string;
  disabled?: boolean;
  pending?: boolean;
  onClick: () => void;
};

export function StripeTestBuyButton(props: Props) {
  return (
    <button
      className="action"
      type="button"
      disabled={props.disabled || props.pending}
      onClick={props.onClick}
    >
      {props.pending ? (props.pendingLabel ?? "Starting…") : props.label}
    </button>
  );
}
