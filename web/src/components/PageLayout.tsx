import type { HTMLAttributes, ReactNode } from 'react';

type Props = HTMLAttributes<HTMLDivElement> & { children: ReactNode };

/** A route surface that intentionally spans every column of the app shell. */
export const FullWidthPage = ({ children, className = '', ...props }: Props): JSX.Element => (
  <div className={`full-width-page ${className}`.trim()} {...props}>{children}</div>
);
