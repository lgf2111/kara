import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

/**
 * Hand-written, in the style of the generated parts beside it: the registry's
 * toast comes with a store and a queue, and this app already knows what it
 * wants to say and for how long.
 */

const toastVariants = cva(
  "group/toast pointer-events-auto flex w-fit max-w-[min(26rem,calc(100vw-2rem))] items-start gap-2.5 overflow-hidden rounded-xl border bg-popover/95 px-3 py-2.5 text-sm text-popover-foreground shadow-lg ring-1 ring-black/20 backdrop-blur-md transition-all [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "border-border/60",
        destructive:
          "border-destructive/40 text-foreground [&_svg]:text-destructive",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Toast({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof toastVariants>) {
  return (
    <div
      data-slot="toast"
      data-variant={variant}
      className={cn(toastVariants({ variant }), className)}
      {...props}
    />
  )
}

function ToastTitle({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="toast-title"
      className={cn("font-heading text-sm font-medium", className)}
      {...props}
    />
  )
}

function ToastDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="toast-description"
      className={cn(
        "mt-0.5 text-xs break-words text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

/**
 * The stack itself: fixed, out of the way, and not in anybody's pointer path.
 *
 * At the top rather than the bottom, which is where a toast usually goes: the
 * bottom of this app is a transport bar two rows deep, and a notice over the
 * play button is a notice in the way. The analysis chip has the top right, so
 * the middle is clear.
 */
function ToastViewport({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="toast-viewport"
      className={cn(
        "pointer-events-none fixed inset-x-0 top-16 z-60 flex flex-col items-center gap-2 px-4 sm:top-20",
        className
      )}
      {...props}
    />
  )
}

export { Toast, ToastTitle, ToastDescription, ToastViewport, toastVariants }
