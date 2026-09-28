"use client";

import { useActionState, useEffect, useRef, useTransition } from "react";
import { useFormStatus } from "react-dom";
import type { FormState } from "@/app/actions";

type Action = (state: FormState, fd: FormData) => Promise<FormState>;

/** Formulario que llama a una Server Action y muestra el error si lo hay. */
export function ActionForm({
  action,
  children,
  className,
  confirm,
  reset = false,
  onDone,
}: {
  action: Action;
  children: React.ReactNode;
  className?: string;
  confirm?: string;
  reset?: boolean;
  onDone?: () => void;
}) {
  const [state, formAction] = useActionState(action, undefined);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) {
      if (reset) ref.current?.reset();
      // Cierra el <details> que contiene el formulario de edición, si lo hay.
      ref.current?.closest("details")?.removeAttribute("open");
      onDone?.();
    }
  }, [state, reset, onDone]);
  return (
    <form
      ref={ref}
      action={formAction}
      className={className}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {children}
      {state?.error && <p className="form-error">{state.error}</p>}
    </form>
  );
}

export function Submit({ children, className = "btn primary", pendingText }: {
  children: React.ReactNode; className?: string; pendingText?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending}>
      {pending ? (pendingText ?? "Guardando…") : children}
    </button>
  );
}

/** Select de estado que guarda al cambiar (sin botón). */
export function StatusSelect({
  value,
  options,
  labels,
  onChangeAction,
}: {
  value: string;
  options: readonly string[];
  labels: Record<string, string>;
  onChangeAction: (value: string) => Promise<void>;
}) {
  const [pending, start] = useTransition();
  return (
    <select
      className={`status-select s-${value}`}
      defaultValue={value}
      disabled={pending}
      onChange={(e) => {
        const v = e.target.value;
        start(() => onChangeAction(v));
      }}
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {labels[o] ?? o}
        </option>
      ))}
    </select>
  );
}
