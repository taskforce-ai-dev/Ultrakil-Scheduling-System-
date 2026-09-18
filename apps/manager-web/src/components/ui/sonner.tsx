"use client"

import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

/**
 * How long a confirmation stays on screen before it clears itself.
 *
 * A notification is a receipt, not a record: what it reports has already
 * been written somewhere durable (a visit's history, the schedule run list),
 * so it has no business outliving the glance it was raised for.
 */
export const TOAST_DURATION_MS = 5_000

/**
 * The portal's one notification surface.
 *
 * Two things about it are load-bearing, and both were learned the hard way in
 * the crew editor.
 *
 * **It is anchored to the top, not the bottom right.** Every overlay in this
 * portal puts its decisions in a footer pinned to the bottom of the overlay —
 * "Save assignment" and "Remove crew" in the crew drawer, "Publish" in the
 * publish dialog. A bottom-right toast lands on top of exactly those: at
 * 1280x720 the save confirmation covered both of the crew drawer's buttons.
 * Nothing in this portal puts a control at the top centre of the window, so
 * that is where the toast goes. On a phone the toast is full width, so it is
 * pushed below the mobile header rather than over its menu button.
 *
 * **It never takes a click.** The toaster is click-through — only the close
 * button inside it accepts a pointer — so even where a toast does overlap
 * something, the control underneath still receives the click instead of the
 * toast silently swallowing it. That also settles the second half of the same
 * bug: sonner pauses a toast's dismiss timer while the pointer is over it, and
 * after clicking a footer button the pointer is left resting exactly there, so
 * the "temporary" confirmation stayed up indefinitely. A surface that takes no
 * pointer events is never hovered, so the timer always runs.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      position="top-center"
      duration={TOAST_DURATION_MS}
      closeButton
      mobileOffset={{ top: 80 }}
      className="toaster group pointer-events-none"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
          // The one part of a toast that is allowed to be a hit target.
          closeButton: "pointer-events-auto",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
