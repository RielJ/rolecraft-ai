import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";
import { cn } from "@/web/lib/utils";

/*
 * Icons in this app lead their label, so a button with an icon sits 2px tighter on the icon
 * side than on the text side (optical alignment).
 */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-full text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,scale,filter] duration-150 ease-out outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // Disabled drops the light entirely: a dimmed glow reads as muddy brown, not as "not yet".
        default:
          "glow-button bg-primary text-primary-foreground hover:brightness-110 disabled:bg-secondary disabled:bg-none disabled:text-muted-foreground disabled:opacity-100 disabled:shadow-none",
        destructive:
          "border border-destructive/35 bg-destructive/15 text-destructive hover:bg-destructive/25 focus-visible:ring-destructive/40",
        outline:
          "border border-white/12 bg-white/[0.03] shadow-[inset_0_1px_0_var(--sheen)] hover:border-white/20 hover:bg-white/[0.07]",
        secondary: "bg-secondary text-secondary-foreground shadow-[inset_0_1px_0_var(--sheen)] hover:bg-accent",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:ps-2.5 has-[>svg]:pe-3",
        xs: "h-6 gap-1 px-2 text-xs has-[>svg]:ps-1 has-[>svg]:pe-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 px-3 has-[>svg]:ps-2 has-[>svg]:pe-2.5",
        lg: "h-10 px-6 has-[>svg]:ps-3.5 has-[>svg]:pe-4",
        icon: "size-9",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

/** Press feedback: 0.96 over 150ms, never when disabled, never under reduced motion. */
const PRESS = "motion-safe:not-disabled:active:scale-[0.96]";

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  static: isStatic = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    /** No press scale: for menu-like rows and anywhere the motion would distract. */
    static?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size }), !isStatic && variant !== "link" && PRESS, className)}
      {...props}
    />
  );
}

export { Button, buttonVariants };
