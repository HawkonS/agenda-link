import { useId, useRef, type ReactNode, type FormHTMLAttributes } from "react";
import {
  FormProvider,
  useForm,
  type FieldValues,
  type Resolver,
} from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { ZodTypeAny } from "zod";

/** Shared RHF boundary for controlled editors; validation and focus stay local to each form. */
export function ValidatedForm<T extends FieldValues>({
  values,
  schema,
  onSubmit,
  onInvalidField,
  children,
  footer,
  ...props
}: Omit<FormHTMLAttributes<HTMLFormElement>, "onSubmit"> & {
  values: T;
  schema: ZodTypeAny;
  onSubmit: NonNullable<FormHTMLAttributes<HTMLFormElement>["onSubmit"]>;
  footer?: ReactNode;
  onInvalidField?: (name: string) => void;
}) {
  const id = useId();
  const ref = useRef<HTMLFormElement>(null);
  const methods = useForm<T>({
    values,
    resolver: zodResolver(schema as never) as Resolver<T>,
    // Avoid moving the next control during pointerdown when an empty field blurs.
    mode: "onSubmit",
    reValidateMode: "onChange",
    resetOptions: { keepErrors: true, keepTouched: true },
    shouldFocusError: false,
  });
  return (
    <FormProvider {...methods}>
      <form
        {...props}
        ref={ref}
        id={props.id || id}
        noValidate
        onSubmit={(event) => {
          void methods.handleSubmit(
            () => onSubmit(event),
            (errors) => {
              onInvalidField?.(Object.keys(errors)[0] || "");
              // Advanced sections must open before focusing their invalid controls.
              requestAnimationFrame(() => {
                const invalid = ref.current?.querySelector<HTMLElement>(
                  '[aria-invalid="true"]',
                );
                for (
                  let parent = invalid?.parentElement;
                  parent;
                  parent = parent.parentElement
                ) {
                  if (parent instanceof HTMLDetailsElement) parent.open = true;
                }
                invalid?.focus();
                invalid?.scrollIntoView?.({ block: "nearest" });
              });
            },
          )(event);
        }}
      >
        {footer ? (
          <>
            <div className="modal-form-fields">{children}</div>
            {footer}
          </>
        ) : (
          children
        )}
      </form>
    </FormProvider>
  );
}
