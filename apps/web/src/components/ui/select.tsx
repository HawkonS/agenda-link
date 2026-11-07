import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "../../lib/utils";

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;
export const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn("select-trigger", className)}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = "SelectTrigger";
export const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      position="popper"
      sideOffset={5}
      collisionPadding={12}
      className={cn("select-content", className)}
      {...props}
    >
      <SelectPrimitive.ScrollUpButton className="select-scroll-button">
        <ChevronUp />
      </SelectPrimitive.ScrollUpButton>
      <SelectPrimitive.Viewport className="select-viewport">
        {children}
      </SelectPrimitive.Viewport>
      <SelectPrimitive.ScrollDownButton className="select-scroll-button">
        <ChevronDown />
      </SelectPrimitive.ScrollDownButton>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
));
SelectContent.displayName = "SelectContent";
export const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn("select-item", className)}
    {...props}
  >
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    <SelectPrimitive.ItemIndicator className="select-indicator">
      <Check />
    </SelectPrimitive.ItemIndicator>
  </SelectPrimitive.Item>
));
SelectItem.displayName = "SelectItem";
