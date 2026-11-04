import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface ControlActionProps {
  /** Both the tooltip and the accessible name: one label, said once. */
  readonly label: string;
  readonly children: ReactNode;
  readonly onClick: () => void;
  /**
   * For a control that is on or off rather than momentary: it says so to a
   * screen reader and is drawn held down. Left out for the rest, which have
   * nothing to be pressed about — a play button that reported itself unpressed
   * would be announced as a switch it is not.
   */
  readonly pressed?: boolean | undefined;
  readonly disabled?: boolean;
}

/**
 * One button in the bar across the bottom: an icon and its name.
 *
 * Forty-four pixels square on a phone, dropping to forty where there is a
 * pointer: the bar is reached for with a thumb in a dark room.
 */
export function ControlAction({
  label,
  children,
  onClick,
  pressed,
  disabled = false,
}: ControlActionProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-lg"
            aria-label={label}
            aria-pressed={pressed}
            disabled={disabled}
            className={cn(
              'size-11 text-white/85 hover:bg-white/10 hover:text-white sm:size-10',
              pressed === true && 'bg-white/15 text-white',
            )}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
