import { Menu } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface SongsButtonProps {
  readonly onClick: () => void;
  readonly className?: string;
}

/**
 * The way back to the songs, which is the same button whether a song is on or
 * the stage is empty.
 *
 * An icon with its name in a tooltip rather than the word: the bar it sits in
 * is laid over somebody's video, and the title beside it is the thing worth
 * reading. The accessible name stays the words, so nothing is lost to a
 * screen reader or to anyone who never hovers.
 */
export function SongsButton({ onClick, className }: SongsButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-lg"
            aria-label="songs"
            className={cn(
              'size-11 flex-none text-white/85 hover:bg-white/10 hover:text-white sm:size-10',
              className,
            )}
            onClick={onClick}
          />
        }
      >
        <Menu className="size-5" aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent>songs</TooltipContent>
    </Tooltip>
  );
}
