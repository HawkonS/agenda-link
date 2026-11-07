import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { cn } from "../../lib/utils";
export const Popover = PopoverPrimitive.Root;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "start", ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={6}
      collisionPadding={12}
      className={cn("popover-content", className)}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = "PopoverContent";
