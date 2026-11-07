import type { HTMLAttributes, LabelHTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";
export function FieldGroup(props: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn("field-group", props.className)} />;
}
export function Field(props: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn("form-field", props.className)} />;
}
export function FieldLabel(props: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label {...props} className={cn("field-label", props.className)} />;
}
export function FieldDescription(props: HTMLAttributes<HTMLParagraphElement>) {
  return <p {...props} className={cn("field-description", props.className)} />;
}
export function FieldError({
  children,
  id,
}: {
  children?: ReactNode;
  id?: string;
}) {
  return children ? (
    <p id={id} role="alert" className="field-error">
      {children}
    </p>
  ) : null;
}
